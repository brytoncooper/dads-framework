import { afterEach, describe, expect, it } from "vitest";

import { composeFeatureFlags, effectiveFeatureStateSchema, hashFeatureState } from "../index.js";
import {
  FakeTenantDirectory,
  featureFlagDefinitionFactory,
  FixedClock,
  InMemoryFeatureFlagStore,
} from "../testing/index.js";
import { fromFixed, getRoute, requireSession, routeGroup } from "@dads-framework/http";
import { buildTestApp, TEST_SUBJECT_HEADER, type TestApp } from "@dads-framework/http/testing";

import {
  createFeatureFlagPreviewResolver,
  type FeatureFlagPreviewRecord,
  readFeatureFlagPreview,
} from "./feature-flag-preview.js";
import { type FeatureFlagContextResolver, FeatureFlagRequestEvaluator } from "./feature-flag-request-evaluator.js";
import { createFeatureFlagRoutes } from "./feature-flag-routes.js";

const flag = featureFlagDefinitionFactory({ slug: "orders.bulk-import" });
const now = new Date("2026-09-10T12:00:00.000Z");
const owner = { type: "user", id: "pilot-user" };
const preview: FeatureFlagPreviewRecord = {
  owner,
  context: { kind: "tenant", tenantId: "pilot" },
  feature: flag.slug,
  active: true,
  allowsWrites: false,
  expiresAt: new Date("2026-09-11T12:00:00.000Z"),
};

const resolveContext: FeatureFlagContextResolver = ({ context }) =>
  context === "pilot" || context === "other" ? { kind: "tenant", tenantId: context } : null;

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("feature flag previews", () => {
  it("applies the preview to the caller's snapshot while keeping public and live state isolated", async () => {
    const flags = composeFeatureFlags({
      definitions: [flag],
      publicSlugs: [flag.slug],
      store: new InMemoryFeatureFlagStore(),
      tenants: new FakeTenantDirectory(),
      clock: new FixedClock(now),
      readPreview: readFeatureFlagPreview,
    });
    app = await buildTestApp({
      routes: [
        ...createFeatureFlagRoutes({
          featureFlags: flags,
          manage: {
            kind: "permission",
            resourceType: "app/settings",
            permission: "manage_feature_flags",
            resourceId: fromFixed("main"),
          },
        }),
        ...routeGroup("Preview scope", [
          getRoute({
            path: "/compare-preview-contexts",
            summary: "Checks a flag from two contexts in the same request",
            access: requireSession(),
            response: effectiveFeatureStateSchema,
            handler: async () => {
              const own = await flags.evaluatorReadingStatesOncePerRequest.isActive({
                slug: flag.slug,
                context: preview.context,
              });
              const other = await flags.evaluatorReadingStatesOncePerRequest.isActive({
                slug: flag.slug,
                context: { kind: "tenant", tenantId: "other" },
              });
              expect(own).toBe(true);
              expect(other).toBe(false);
              return flags.effective.execute(preview.context);
            },
          }),
        ]),
      ],
      featureState: {
        evaluator: new FeatureFlagRequestEvaluator(flags.effective, resolveContext),
        hashHeader: "x-test-state",
        clientHashHeader: "x-test-expected-state",
        contextHeader: "x-test-context",
        preview: {
          resolver: createFeatureFlagPreviewResolver({
            definitions: [flag],
            resolveContext,
            findPreview: (id) => Promise.resolve(id === "preview-1" ? preview : null),
            canPreview: ({ subject }) => Promise.resolve(subject.id === owner.id),
            now: () => now,
          }),
          requestHeader: "x-test-preview",
          droppedHeader: "x-test-preview-dropped",
        },
      },
    });

    const headers = {
      [TEST_SUBJECT_HEADER]: owner.id,
      "x-test-preview": "preview-1",
      "x-test-context": "pilot",
    };
    const [allowed, otherTenant, otherPerson, publicState] = await Promise.all([
      app.inject({ method: "GET", url: "/feature-state", headers }),
      app.inject({
        method: "GET",
        url: "/feature-state",
        headers: { ...headers, "x-test-context": "other" },
      }),
      app.inject({
        method: "GET",
        url: "/feature-state",
        headers: { ...headers, [TEST_SUBJECT_HEADER]: "other-user" },
      }),
      app.inject({ method: "GET", url: "/feature-state/public", headers }),
    ]);
    const evaluated = await app.inject({
      method: "GET",
      url: "/compare-preview-contexts",
      headers,
    });
    expect(evaluated.statusCode).toBe(200);
    const previewHash = hashFeatureState([flag.slug]);
    expect(allowed.json()).toEqual({
      data: { features: [flag.slug], stateHash: previewHash },
    });
    expect(allowed.headers["x-test-state"]).toBe(previewHash);
    expect(allowed.headers["cache-control"]).toBe("private, no-store");

    for (const response of [otherTenant, otherPerson]) {
      expect(response.json()).toEqual({
        data: { features: [], stateHash: hashFeatureState([]) },
      });
      expect(response.headers["x-test-preview-dropped"]).toBe("1");
    }
    expect(publicState.json()).toEqual({ data: { features: [] } });
    expect(await flags.effective.execute(preview.context)).toEqual({
      features: [],
      stateHash: hashFeatureState([]),
    });
  });

  it.each([
    ["revoked permission", preview, owner, false],
    ["expired record", { ...preview, expiresAt: now }, owner, true],
    ["undefined flag", { ...preview, feature: "removed.flag" }, owner, true],
    ["acting as another person", preview, { ...owner, id: "other" }, true],
  ] as const)("drops a preview with %s", async (_case, record, subject, authorized) => {
    const resolver = createFeatureFlagPreviewResolver({
      definitions: [flag],
      resolveContext,
      findPreview: () => Promise.resolve(record),
      canPreview: () => Promise.resolve(authorized),
      now: () => now,
    });
    await expect(
      resolver.resolve({
        previewId: "preview-1",
        authenticatedSubject: owner,
        subject,
        context: "pilot",
      }),
    ).resolves.toBeNull();
  });
});
