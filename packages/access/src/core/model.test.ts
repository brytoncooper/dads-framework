/**
 * What/why: access() is the only authoring surface. This suite locks the
 * normative sample — roles, grantable, granting, combinators, and zod enums
 * — so later emitters can trust the tokens.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { both, excluding, gated, through } from "./combinators.js";
import { entityHandle } from "./entity-handle.js";
import { lifecycleTrigger } from "./lifecycle.js";
import { access } from "./model.js";
import { testGrantable } from "./test-support/test-grantable.js";

const idSchema = z.string();
let wireNameSerial = 0;

function nextWireName(label: string): string {
  wireNameSerial += 1;
  return `test/${label}-${wireNameSerial}`;
}

const membershipEnds = lifecycleTrigger("membershipEnds");
const permissionSetDeleted = lifecycleTrigger("permissionSetDeleted");

describe("access()", () => {
  it("mints typed role and permission tokens from the authored keys", () => {
    const Site = entityHandle({
      wireName: nextWireName("site"),
      idSchema,
    });
    const Owner = entityHandle({
      wireName: nextWireName("owner"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const site = access(Site, {
      roles: {
        owner: Owner,
        admin: Person,
        formulator: testGrantable({
          label: { key: "grants.formulator" },
        }),
      },
      granting: {
        requires: ["manage_direct_grants"],
        removedWhen: [membershipEnds, permissionSetDeleted],
      },
      permissions: (roles) => ({
        view: [roles.admin],
        manage_direct_grants: [roles.admin, roles.formulator],
      }),
    });

    expect(site.roles.admin.roleName).toBe("admin");
    expect(site.roles.formulator.holder).toEqual(
      testGrantable({
        label: { key: "grants.formulator" },
      }),
    );
    expect(site.permissions.view.permissionName).toBe("view");
    const permissionEnum = site.zod.permission;
    const roleEnum = site.zod.role;
    if (permissionEnum === undefined || roleEnum === undefined) {
      throw new Error("expected zod enums");
    }
    expect(permissionEnum.parse("view")).toBe("view");
    expect(roleEnum.parse("formulator")).toBe("formulator");
  });

  it("records through, gated, excluding, and both as permission terms", () => {
    const Workspace = entityHandle({
      wireName: nextWireName("workspace"),
      idSchema,
    });
    const Organization = entityHandle({
      wireName: nextWireName("organization"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const organization = access(Organization, {
      roles: {
        admin: Person,
      },
      permissions: (roles) => ({
        view: [roles.admin],
        manage_workspace_business: [roles.admin],
      }),
    });

    const workspace = access(Workspace, {
      roles: {
        owner: Organization,
        admin: Person,
        banned: Person,
      },
      permissions: (roles) => ({
        view: [
          roles.admin,
          through(roles.owner, organization.permissions.view),
        ],
        manage_recipes: [
          gated(
            through(
              roles.owner,
              organization.permissions.manage_workspace_business,
            ),
            roles.admin,
          ),
        ],
        manage: [
          excluding(roles.admin, roles.banned),
          both(roles.admin, roles.admin),
        ],
      }),
    });

    const sealed = workspace.resolve();

    expect(sealed.expressions["view"]).toEqual([
      workspace.roles.admin,
      {
        kind: "through",
        role: workspace.roles.owner,
        target: organization.permissions.view,
      },
    ]);
    expect(sealed.expressions["manage_recipes"]?.[0]).toMatchObject({
      kind: "gated",
    });
    expect(sealed.expressions["manage"]?.[0]).toMatchObject({
      kind: "excluding",
    });
    expect(sealed.expressions["manage"]?.[1]).toMatchObject({
      kind: "both",
    });
  });

  it("typechecks a 30-role / 40-permission definition without special machinery", () => {
    const Hub = entityHandle({
      wireName: nextWireName("hub"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const roles: Record<string, ReturnType<typeof entityHandle>> = {};
    for (let index = 0; index < 30; index += 1) {
      roles[`role_${index}`] = Person;
    }

    const hub = access(Hub, {
      roles,
      permissions: (authoredRoles) => {
        const permissions: Record<
          string,
          readonly (typeof authoredRoles)[string][]
        > = {};
        for (let index = 0; index < 40; index += 1) {
          const firstRole = authoredRoles["role_0"];
          if (firstRole === undefined) {
            throw new Error("expected role_0");
          }
          permissions[`permission_${index}`] = [firstRole];
        }
        return permissions;
      },
    });

    expect(Object.keys(hub.roles)).toHaveLength(30);
    const hubPermissions = hub.zod.permission;
    if (hubPermissions === undefined) {
      throw new Error("expected permission enum");
    }
    expect(hubPermissions.safeParse("permission_0").success).toBe(true);
    expect(hubPermissions.safeParse("permission_39").success).toBe(true);
    expect(hubPermissions.safeParse("permission_40").success).toBe(false);
  });
});
