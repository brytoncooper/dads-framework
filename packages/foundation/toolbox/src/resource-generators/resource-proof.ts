import type { GenerationPlan } from "./generation-plan.js";
import { camel, pascal } from "./names.js";

export function resourceProof(
  plan: GenerationPlan,
  domain: string,
  name: string,
): void {
  const item = camel(name);
  const record = pascal(name);
  plan.create(
    `domains/${domain}/server/${name}-resource.test.ts`,
    `import { compileAccess } from "@dads-framework/access";
import { createAccessHarness } from "@dads-framework/access/testing";
import { apiErrorSchema, ROW_VERSION_CONFLICT } from "@dads-framework/contract";
import { createHttpApp, registerRoutes } from "@dads-framework/http";
import { expect, it } from "vitest";

import { account, tenantAccess } from "../../../libraries/app-runtime/index.js";
import { ${item}SaveRoute, type ${record} } from "../contract/${name}-resource.js";
import { create${record}Routes } from "./${name}-resource.js";
import { ${item}Writer } from "./${name}-writer.js";

it("denies a caller without an edit relationship and rejects a stale draft", async () => {
  let current: ${record} = { id: "sample", title: "Original", rowVersion: 1 };
  const tenantId = "838dc845-3883-43f7-8685-32acedbc29e5";
  const access = createAccessHarness(compileAccess([account, tenantAccess.tenant]));
  const editor = access.actor(account, "editor");
  const outsider = access.actor(account, "outsider");
  access.grant(tenantAccess.tenant.roles.owner, tenantId).to(editor);

  const routes = create${record}Routes({
    list: () => Promise.resolve({ items: [current], total: 1 }),
    read: () => Promise.resolve(current),
  }, {
    save(subject, scopedTenant, id, draft) {
      expect(subject).toEqual(editor);
      expect(scopedTenant).toBe(tenantId);
      if (current.rowVersion !== draft.expectedRowVersion) return Promise.resolve(undefined);
      current = { id, title: draft.title, rowVersion: current.rowVersion + 1 };
      return Promise.resolve(current);
    },
  });

  const app = await createHttpApp({ nodeEnv: "test", trustedOrigins: [], logger: false });
  try {
    registerRoutes(app, {
      routes,
      authorization: access.authorization,
      subjects: { resolve: (request) => Promise.resolve(request.headers["x-editor"] === "yes" ? editor : outsider) },
    });

    const save = (title: string, asEditor: boolean) => app.inject({
      method: "PATCH",
      url: ${item}SaveRoute.path(tenantId, current.id),
      headers: { "x-editor": asEditor ? "yes" : "no" },
      payload: { title, expectedRowVersion: 1 },
    });
    const denied = await save("Denied", false);
    expect(denied.statusCode).toBe(404);
    expect(current.title).toBe("Original");
    const saved = await save("Current", true);
    expect(saved.statusCode).toBe(200);
    const stale = await save("Old draft", true);
    expect(stale.statusCode).toBe(409);
    expect(apiErrorSchema.parse(stale.json()).error.code).toBe(ROW_VERSION_CONFLICT);
    expect(current).toEqual({ id: "sample", title: "Current", rowVersion: 2 });
  } finally {
    await app.close();
  }
});

it("passes the caller and tenant edit permission to the protected writer", async () => {
  const subject = { type: account.wireName, id: "editor" };
  const tenantId = "838dc845-3883-43f7-8685-32acedbc29e5";
  const denied = new Error("Permission was revoked before the write");
  const writer = ${item}Writer((check) => {
    expect(check).toEqual({
      subject,
      resourceId: tenantId,
      permission: tenantAccess.tenant.permissions.manage_tenant,
    });
    return Promise.reject(denied);
  });
  await expect(writer.save(subject, tenantId, "sample", { title: "Changed", expectedRowVersion: 1 }))
    .rejects.toBe(denied);
});
`,
  );
}
