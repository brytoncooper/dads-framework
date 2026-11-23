/**
 * What: the management routes follow the application's permission through
 * the HTTP kit's `Authorization` check, refusing a caller without it with a
 * plain 404; the effective-state route answers the request's own snapshot,
 * resolved by the application's context resolver; the public route answers
 * without a session.
 * Why: every protected operation proves its denial, and the tenant a request
 * sees must be the one the application resolved, never one the caller names.
 */
import { afterEach, describe, expect, it } from "vitest";

import { relationshipWrite } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";
import { composeFeatureFlags, type FeatureFlags, type FeatureFlagState } from "../index.js";
import {
  InMemoryFeatureFlagStore,
  FakeTenantDirectory,
  featureFlagDefinitionFactory,
  FixedClock,
} from "../testing/index.js";
import { fromFixed, type PermissionAccess } from "@dads-framework/http";
import { buildTestApp, TEST_SUBJECT_HEADER, type TestApp } from "@dads-framework/http/testing";

import { FeatureFlagRequestEvaluator } from "./feature-flag-request-evaluator.js";
import { createFeatureFlagRoutes } from "./feature-flag-routes.js";

const ADMIN = "user-admin";
const STRANGER = "user-stranger";
const CONTEXT_HEADER = "x-test-context";
const definition = featureFlagDefinitionFactory({ slug: "orders.bulk-import" });
const publicDefinition = featureFlagDefinitionFactory({
  slug: "docs.public-pages",
});
const MANAGE: PermissionAccess = {
  kind: "permission",
  resourceType: "app/settings",
  permission: "manage_feature_flags",
  resourceId: fromFixed("main"),
};

function composed(states: readonly FeatureFlagState[] = []): FeatureFlags {
  const store = new InMemoryFeatureFlagStore();
  store.seed(states);
  return composeFeatureFlags({
    definitions: [definition, publicDefinition],
    publicSlugs: [publicDefinition.slug],
    store,
    tenants: new FakeTenantDirectory(),
    clock: new FixedClock(new Date("2026-09-10T12:00:00.000Z")),
  });
}

function authorization(): FakeAuthorization {
  const fake = new FakeAuthorization({
    "app/settings": { manage_feature_flags: ["admin"] },
  });
  fake.seed(
    relationshipWrite({ type: "app/settings", id: "main" }, "admin", {
      type: "user",
      id: ADMIN,
    }),
  );
  return fake;
}

describe("feature flag routes", () => {
  let apps: TestApp[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
  });

  async function appFor(featureFlags: FeatureFlags): Promise<TestApp> {
    const app = await buildTestApp({
      authorization: authorization(),
      routes: createFeatureFlagRoutes({ featureFlags, manage: MANAGE }),
      featureState: {
        evaluator: new FeatureFlagRequestEvaluator(featureFlags.effective, ({ context }) =>
          context === undefined ? null : { kind: "tenant", tenantId: context },
        ),
        hashHeader: "x-test-state-hash",
        clientHashHeader: "x-test-client-state-hash",
        contextHeader: CONTEXT_HEADER,
      },
    });
    apps.push(app);
    return app;
  }

  it("lets a caller holding the permission list and change audiences", async () => {
    const app = await appFor(composed());
    const listed = await app.inject({
      method: "GET",
      url: "/feature-flags",
      headers: { [TEST_SUBJECT_HEADER]: ADMIN },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      data: { flags: [{ definition: { slug: definition.slug } }, {}] },
    });

    const changed = await app.inject({
      method: "POST",
      url: "/feature-flags",
      headers: { [TEST_SUBJECT_HEADER]: ADMIN },
      payload: {
        changes: [
          {
            slug: definition.slug,
            expectedRevision: 0,
            mode: "SELECTED_TENANTS",
            tenantIds: ["t-1"],
          },
        ],
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      data: {
        states: [
          {
            slug: definition.slug,
            audienceMode: "SELECTED_TENANTS",
            revision: 1,
            updatedBy: ADMIN,
          },
        ],
      },
    });

    const history = await app.inject({
      method: "GET",
      url: `/feature-flags/${definition.slug}/history`,
      headers: { [TEST_SUBJECT_HEADER]: ADMIN },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      data: [{ revision: 1, changedBy: ADMIN }],
      meta: { total: 1 },
    });
  });

  it("returns indistinguishable 404s to a caller without the permission", async () => {
    const app = await appFor(composed());
    const requests = [
      { method: "GET" as const, url: "/feature-flags" },
      {
        method: "GET" as const,
        url: `/feature-flags/${definition.slug}/history`,
      },
      {
        method: "POST" as const,
        url: "/feature-flags",
        payload: {
          changes: [{ slug: definition.slug, expectedRevision: 0, mode: "EVERYONE" }],
        },
      },
    ];
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: { [TEST_SUBJECT_HEADER]: STRANGER },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("answers the effective state for the tenant the application resolved", async () => {
    const app = await appFor(
      composed([
        {
          slug: definition.slug,
          audienceMode: "SELECTED_TENANTS",
          rememberedTenants: [
            {
              tenantId: "t-1",
              tenantName: "One",
              enabledAt: "2026-09-10T12:00:00.000Z",
            },
          ],
          revision: 1,
          globalEnabledAt: null,
          updatedAt: "2026-09-10T12:00:00.000Z",
          updatedBy: ADMIN,
        },
      ]),
    );
    const piloted = await app.inject({
      method: "GET",
      url: "/feature-state",
      headers: { [TEST_SUBJECT_HEADER]: STRANGER, [CONTEXT_HEADER]: "t-1" },
    });
    expect(piloted.statusCode).toBe(200);
    expect(piloted.json()).toMatchObject({
      data: { features: [definition.slug] },
    });
    expect(piloted.headers["x-test-state-hash"]).toBe(piloted.json<{ data: { stateHash: string } }>().data.stateHash);

    const other = await app.inject({
      method: "GET",
      url: "/feature-state",
      headers: { [TEST_SUBJECT_HEADER]: STRANGER, [CONTEXT_HEADER]: "t-2" },
    });
    expect(other.json()).toMatchObject({ data: { features: [] } });

    const anonymous = await app.inject({
      method: "GET",
      url: "/feature-state",
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("answers the public list without a session", async () => {
    const app = await appFor(
      composed([
        {
          slug: publicDefinition.slug,
          audienceMode: "EVERYONE",
          rememberedTenants: [],
          revision: 1,
          globalEnabledAt: "2026-09-10T12:00:00.000Z",
          updatedAt: "2026-09-10T12:00:00.000Z",
          updatedBy: ADMIN,
        },
      ]),
    );
    const response = await app.inject({
      method: "GET",
      url: "/feature-state/public",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { features: [publicDefinition.slug] },
    });
  });
});
