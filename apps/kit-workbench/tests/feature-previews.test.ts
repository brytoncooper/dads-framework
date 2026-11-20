import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { relationshipWrite } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";
import {
  effectiveFeatureStateSchema,
  GetEffectiveFeatureState,
  hashFeatureState,
} from "@dads-framework/feature-flags";
import {
  featureFlagDefinitionFactory,
  InMemoryFeatureFlagStore,
} from "@dads-framework/feature-flags/testing";
import { readFeatureFlagPreview } from "@dads-framework/feature-flags-http";
import { getRoute, requireSession, routeGroup } from "@dads-framework/http";
import { buildTestApp } from "@dads-framework/http/testing";
import { tenantIdSchema } from "@dads-framework/tenants";
import { z } from "zod";

import {
  configureFeaturePreviews,
  readFeaturePreview,
} from "../assembly/feature-previews.js";
import { accountEntity, tenantAccess } from "../libraries/app-runtime/index.js";

const tenantId = "a75cc305-ac6f-4a23-b5e4-537c7d18bd02";
const otherTenantId = "b939ed9e-a211-4c68-ad7a-9a9f5f04d1c7";
const account = { type: accountEntity.wireName, id: "test-account" };
const token = "local-test-fixture";

it("requires membership and uses the actual route tenant for previews", async () => {
  const configuration = readFeaturePreview({
    DADS_FEATURE_PREVIEW: JSON.stringify({
      tenantId,
      accountId: account.id,
      feature: "notes.export",
      active: true,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      expiresAt: "2099-02-01T12:00:00Z",
    }),
  });
  if (configuration === undefined)
    throw new Error("Preview fixture is missing");
  const definition = featureFlagDefinitionFactory({ slug: "notes.export" });
  const flags = new GetEffectiveFeatureState(
    [definition],
    new InMemoryFeatureFlagStore(),
    readFeatureFlagPreview,
  );
  const view = tenantAccess.tenant.permissions.view;
  const authorization = new FakeAuthorization({
    [view.entityWireName]: { [view.permissionName]: ["member"] },
  });
  const app = await buildTestApp({
    routes: routeGroup("Preview test", [
      getRoute({
        path: "/api/tenants/:tenantId/notes/features",
        summary: "Read tenant flags",
        access: requireSession(),
        params: z.object({ tenantId: tenantIdSchema }),
        response: effectiveFeatureStateSchema,
        handler: ({ params }) =>
          flags.execute({ kind: "tenant", tenantId: params.tenantId }),
      }),
    ]),
    subjects: { resolve: () => Promise.resolve(account) },
    featureState: configureFeaturePreviews({
      configuration,
      definitions: [definition],
      flags,
      authorization,
    }),
  });
  const headers = {
    "x-feature-preview": token,
    "x-feature-state-context": tenantId,
  };
  try {
    const denied = await app.inject({
      method: "GET",
      url: `/api/tenants/${tenantId}/notes/features`,
      headers,
    });
    expect(denied.headers["x-feature-preview-dropped"]).toBe("1");
    expect(denied.json()).toMatchObject({ data: { features: [] } });

    authorization.seed(
      relationshipWrite(
        { type: view.entityWireName, id: tenantId },
        "member",
        account,
      ),
    );
    const allowed = await app.inject({
      method: "GET",
      url: `/api/tenants/${tenantId}/notes/features`,
      headers,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      data: { features: [definition.slug] },
    });

    const encodedPath = await app.inject({
      method: "GET",
      url: `/api/%74enants/${tenantId}/notes/features`,
      headers: { ...headers, "x-feature-state-context": otherTenantId },
    });
    expect(encodedPath.statusCode).toBe(200);
    expect(encodedPath.headers["x-feature-preview-dropped"]).toBeUndefined();
    expect(encodedPath.headers["x-feature-state-hash"]).toBe(
      hashFeatureState([definition.slug]),
    );
    expect(encodedPath.json()).toEqual(allowed.json());

    const other = await app.inject({
      method: "GET",
      url: `/api/tenants/${otherTenantId}/notes/features`,
      headers,
    });
    expect(other.headers["x-feature-preview-dropped"]).toBe("1");
    expect(other.json()).toMatchObject({ data: { features: [] } });
  } finally {
    await app.close();
  }
});
