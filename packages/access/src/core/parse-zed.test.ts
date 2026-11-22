/**
 * What/why: parseZed is the other half of the parity gate. A hand-written
 * fragment and an emitted document must lower to the same IR.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { excluding, gated, through } from "./combinators.js";
import { accessIrDefinitionsDiff } from "./compare-access-ir.js";
import { emitAccessIr } from "./emit-ir.js";
import { emitZed } from "./emit-zed.js";
import { entityHandle } from "./entity-handle.js";
import { membersOf, wildcard } from "./holders.js";
import { access } from "./model.js";
import { parseZed } from "./parse-zed.js";
import { accessModel } from "./access-model.js";
import { testGrantable } from "./test-support/test-grantable.js";

const idSchema = z.string();

describe("parseZed", () => {
  it("round-trips emitted schema including nested unions and holder unions", () => {
    const User = entityHandle({ wireName: "user", idSchema });
    const Platform = entityHandle({ wireName: "platform", idSchema });
    const Organization = entityHandle({
      wireName: "organizations/organization",
      idSchema,
    });
    const Assignment = entityHandle({
      wireName: "platform/work_assignment",
      idSchema,
    });

    const user = access(User, {
      roles: {},
      permissions: () => ({}),
    });

    const assignment = access(Assignment, {
      roles: { assignee: User },
      permissions: () => ({}),
    });

    const organization = access(Organization, {
      roles: {
        admin: User,
        custodian: User,
        parent_platform: Platform,
        formulator: testGrantable({}),
        platform_tenancy: wildcard(User),
        commissioner: membersOf(assignment.roles.assignee),
        attached_user: [User, wildcard(User)],
      },
      permissions: (roles) => ({
        administer_party: [
          excluding(
            [
              roles.custodian,
              roles.admin,
              through(roles.parent_platform, {
                kind: "permission",
                entityWireName: "platform",
                permissionName: "administer",
              }),
            ],
            roles.platform_tenancy,
          ),
        ],
        create_workspaces: [gated(roles.admin, roles.platform_tenancy)],
        act: [
          through(roles.parent_platform, {
            kind: "role",
            entityWireName: "platform",
            roleName: "super_admin",
            holder: User,
          }),
        ],
      }),
    });

    const model = accessModel([user, assignment, organization]);
    const emitted = emitZed(model);
    const parsed = parseZed(emitted);
    expect(accessIrDefinitionsDiff(emitAccessIr(model), parsed)).toEqual([]);
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
