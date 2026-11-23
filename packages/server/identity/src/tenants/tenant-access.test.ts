import { actor, compileAccess, emitAccessIr } from "@dads-framework/access";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTenantAccess } from "./tenant-access.js";

describe("tenant access", () => {
  it("binds membership to the account's actual subject type and reserves tenant changes to owners", () => {
    const account = actor("accounts/user", { id: z.string() });
    const tenant = createTenantAccess(account);
    const model = compileAccess([account, tenant.tenant]);
    const definition = emitAccessIr(model).find((entry) => entry.wireName === tenant.tenant.wireName);
    expect(definition?.roles.map((role) => role.subjects)).toEqual([
      [{ kind: "type", wireName: account.wireName }],
      [{ kind: "type", wireName: account.wireName }],
      [{ kind: "type", wireName: account.wireName }],
    ]);
    expect(
      definition?.permissions.find(
        (permission) => permission.name === tenant.tenant.permissions.manage_tenant.permissionName,
      )?.terms,
    ).toEqual([{ kind: "role", name: tenant.tenant.roles.owner.roleName }]);
  });
});
