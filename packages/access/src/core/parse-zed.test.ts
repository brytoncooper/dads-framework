/**
 * What/why: parseZed is the other half of the parity gate. A hand-written
 * fragment and an emitted document must lower to the same IR, and
 * compileAccessFromIr must lower parsed IR straight back into an AccessModel.
 */
import { describe, expect, it } from "vitest";

import {
  accessIrDefinitionsDiff,
  actor,
  allOf,
  anyOf,
  compileAccess,
  compileAccessFromIr,
  emitAccessIr,
  emitZed,
  parseZed,
  resource,
} from "../index.js";
import { testGrantable } from "./test-support/test-grantable.js";

describe("parseZed", () => {
  it("round-trips emitted schema including nested unions, holder unions, and role-target arrows", () => {
    const user = actor("user");
    const platform = resource("platform", {
      roles: { super_admin: user },
      can: ({ super_admin }) => ({ administer: super_admin }),
    });
    const assignment = resource("platform/work_assignment", {
      roles: { assignee: user },
    });
    const organization = resource("organizations/organization", {
      roles: {
        admin: user,
        custodian: user,
        parent_platform: platform,
        formulator: testGrantable({}),
        platform_tenancy: user.anyone,
        commissioner: assignment.roles.assignee,
        attached_user: [user, user.anyone],
      },
      can: ({ admin, custodian, parent_platform, platform_tenancy }) => ({
        administer_party: anyOf(
          custodian,
          admin,
          parent_platform.administer,
        ).unless(platform_tenancy),
        create_workspaces: allOf(admin, platform_tenancy),
        act: parent_platform.super_admin,
      }),
    });

    const model = compileAccess([user, assignment, organization]);
    const emitted = emitZed(model);
    const parsed = parseZed(emitted);
    expect(accessIrDefinitionsDiff(emitAccessIr(model), parsed)).toEqual([]);

    const fromIr = compileAccessFromIr(parsed);
    expect(
      accessIrDefinitionsDiff(emitAccessIr(model), emitAccessIr(fromIr)),
    ).toEqual([]);
  });

  it("parses a hand-written fragment with comments and empty user", () => {
    const parsed = parseZed(`
      // banner
      definition user {}

      definition platform/support_session {
        relation grantee: user
        permission act = grantee
      }
    `);

    expect(parsed).toEqual([
      { wireName: "user", roles: [], permissions: [] },
      {
        wireName: "platform/support_session",
        roles: [
          { name: "grantee", subjects: [{ kind: "type", wireName: "user" }] },
        ],
        permissions: [
          { name: "act", terms: [{ kind: "role", name: "grantee" }] },
        ],
      },
    ]);
  });

  it("parses block comments, use expiration, with expiration, .all(), and .any()", () => {
    const parsed = parseZed(`
      /* Top-level block comment
         spanning multiple lines */
      use expiration

      definition user {}

      definition group {
        relation member: user
        permission read = member
      }

      definition doc {
        relation viewer: user with expiration | group#member with expiration | user:* with expiration
        relation parent: group
        permission view = viewer + parent.all(read) + parent.any(read)
      }
    `);

    expect(parsed[2]).toEqual({
      wireName: "doc",
      roles: [
        {
          name: "viewer",
          subjects: [
            { kind: "type", wireName: "user", expiration: true },
            {
              kind: "userset",
              wireName: "group",
              relation: "member",
              expiration: true,
            },
            { kind: "wildcard", wireName: "user", expiration: true },
          ],
        },
        { name: "parent", subjects: [{ kind: "type", wireName: "group" }] },
      ],
      permissions: [
        {
          name: "view",
          terms: [
            { kind: "role", name: "viewer" },
            {
              kind: "through-all",
              roleName: "parent",
              targetPermission: "read",
            },
            { kind: "through", roleName: "parent", targetPermission: "read" },
          ],
        },
      ],
    });

    const lowered = compileAccessFromIr(parsed);
    expect(accessIrDefinitionsDiff(parsed, emitAccessIr(lowered))).toEqual([]);
  });

  it("detects expiration and through-all differences in accessIrDefinitionsDiff", () => {
    const withExp = parseZed(`
      use expiration
      definition doc {
        relation viewer: user with expiration
        relation parent: group
        permission view = viewer + parent.all(read)
      }
    `);
    const withoutExp = parseZed(`
      definition doc {
        relation viewer: user
        relation parent: group
        permission view = viewer + parent->read
      }
    `);

    const diff = accessIrDefinitionsDiff(withExp, withoutExp);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.some((entry) => entry.includes("expiration"))).toBe(true);
    expect(diff.some((entry) => entry.includes("through-all"))).toBe(true);
  });

  it("reports accurate 1-based line numbers on unsupported constructs", () => {
    expect(() =>
      parseZed(
        "/*\nline 2\n*/\ncaveat ip_check(ip string) { ip == '1.1.1.1' }",
      ),
    ).toThrow(/line 4:.*caveat/);

    expect(() =>
      parseZed("definition doc {\n  relation viewer: user with ip_check\n}"),
    ).toThrow(/line 2:.*with ip_check/);

    expect(() =>
      parseZed("definition doc {\n  permission empty = nil\n}"),
    ).toThrow(/line 2:.*nil/);

    expect(() => parseZed("use unknown_pragma\ndefinition user {}")).toThrow(
      /line 1:.*use unknown_pragma/,
    );
  });
});
