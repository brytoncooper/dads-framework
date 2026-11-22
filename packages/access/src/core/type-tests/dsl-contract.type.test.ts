/**
 * Compile-time contract proofs for the ergonomic access DSL and typed runtime client.
 * Every @ts-expect-error assertion is checked by `tsc -p packages/access/tsconfig.tests.json`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  actor,
  allOf,
  anyOf,
  compileAccess,
  every,
  resource,
  type ActorRef,
  type PermissionToken,
} from "../../index.js";
import { createAccessClient } from "../../runtime/index.js";
import { FakeAuthorization } from "../../runtime/fake-authorization.js";

describe("DSL compile-time contracts", () => {
  it("enforces fail-closed inherit keys, parent permissions, and nested children types", () => {
    const user = actor("user", { id: z.uuid() });

    const organization = resource("organization", {
      roles: {
        admin: user,
        member: user,
      },
      can: ({ admin, member }) => ({
        manage: admin,
        edit: admin,
        view: [admin, member],
      }),
      children: {
        task: {
          inherit: "all",
          roles: { assignee: user },
          can: ({ assignee, parent }) => ({
            edit: [parent.edit, assignee],
            comment: assignee,
          }),
          children: {
            photo: {
              inherit: "all",
            },
          },
        },
        billing: {
          inherit: ["manage"],
          roles: { accountant: user },
          can: ({ accountant }) => ({
            view: accountant,
          }),
        },
        order: {
          inherit: "none",
          roles: { buyer: user },
          can: ({ buyer }) => ({
            view: buyer,
          }),
        },
      },
    });

    expectTypeOf(user("u1")).toExtend<ActorRef<"user">>();
    expectTypeOf(organization.task.can.edit).toExtend<PermissionToken>();
    expectTypeOf(
      organization.task.photo.can.comment,
    ).toExtend<PermissionToken>();
    expectTypeOf(organization.billing.can.manage).toExtend<PermissionToken>();
    expectTypeOf(organization.billing.can.view).toExtend<PermissionToken>();

    // Fail-closed: billing only inherited "manage" and locally added "view" — NOT "edit".
    expectTypeOf<"edit">().not.toExtend<
      keyof typeof organization.billing.can
    >();
    expectTypeOf<"manage">().not.toExtend<
      keyof typeof organization.order.can
    >();

    // @ts-expect-error -- billing did not inherit edit permission from organization
    void organization.billing.can.edit;
    // @ts-expect-error -- billing instance does not expose uninherited edit target
    void organization.billing("b1").edit;

    const badChildCheck = () => {
      organization.child("bad_inherit", {
        // @ts-expect-error -- nonexistent permission is rejected in .child() inherit list
        inherit: ["does_not_exist"],
      });

      organization.child("bad_parent_perm", {
        inherit: "none",
        can: ({ parent }) => {
          // @ts-expect-error -- parent.nonexistent is not a real permission on organization
          void parent.nonexistent;
          return { view: parent.view };
        },
      });

      const badInline = resource("bad_inline", {
        roles: { admin: user },
        can: ({ admin }) => ({ view: admin }),
        children: {
          sub: {
            inherit: ["not_a_parent_perm"],
          },
        },
      });
      // @ts-expect-error -- inline child with nonexistent inherit key produces invalid resource type
      compileAccess([badInline]);

      resource("bad_inline_parent_perm", {
        roles: { admin: user },
        can: ({ admin }) => ({ view: admin }),
        children: {
          sub: {
            inherit: "none",
            can: ({ parent }) => {
              // @ts-expect-error -- parent.nope is not a real permission on parent resource
              void parent.nope;
              return { view: parent.view };
            },
          },
        },
      });
    };
    expect(typeof badChildCheck).toBe("function");

    const model = compileAccess([organization]);
    expect(model.definitions.length).toBeGreaterThan(0);
  });

  it("enforces shared parent permissions on multi-parent resources and every(link) targets", () => {
    const user = actor("user");

    const organization = resource("organization", {
      roles: { admin: user, member: user },
      can: ({ admin, member }) => ({
        manage: admin,
        edit: admin,
        view: [admin, member],
      }),
    });

    const folder = resource("folder", {
      recursive: true,
      roles: { editor: user, viewer: user },
      can: ({ editor, viewer }) => ({
        edit: editor,
        view: [editor, viewer],
      }),
    });

    const reviewGroup = resource("review_group", {
      roles: { reviewer: user },
      can: ({ reviewer }) => ({
        approve: reviewer,
        view: reviewer,
      }),
    });

    const document = resource("document", {
      parents: [organization, folder],
      roles: {
        author: user,
        reviewGroup,
      },
      can: ({ author, parents, reviewGroup: rg }) => ({
        view: anyOf(author, parents.view, every(rg).view),
        approve: allOf(parents.edit, every(rg).approve),
      }),
    });

    const invalidUsages = () => {
      resource("bad_multi_parent", {
        parents: [organization, folder],
        can: ({ parents }) => {
          // @ts-expect-error -- manage is not shared across both organization and folder
          void parents.manage;
          return { view: parents.view };
        },
      });

      resource("bad_every", {
        roles: { reviewGroup },
        can: ({ reviewGroup: rg }) => {
          // @ts-expect-error -- delete is not a real permission on reviewGroup
          void every(rg).delete;
          return { view: every(rg).view };
        },
      });
    };

    expect(typeof invalidUsages).toBe("function");
    expect(document.wireName).toBe("document");
  });

  it("rejects mismatched subject types in createAccessClient.add and remove", () => {
    const user = actor("user");
    const service = actor("service");

    const team = resource("team", {
      roles: { admin: user, member: user },
      can: ({ admin, member }) => ({ view: [admin, member] }),
    });

    const organization = resource("organization", {
      roles: {
        admin: user,
        member: user,
        guest: user.expiring,
        public_viewer: user.anyone,
        team_member: team.roles.member,
      },
      can: ({ admin, member }) => ({
        manage: admin,
        view: [admin, member],
      }),
    });

    const task = organization.child("task", {
      inherit: "all",
      roles: { assignee: user },
      can: ({ assignee }) => ({ edit: assignee }),
    });

    const client = createAccessClient(new FakeAuthorization());

    const validCalls = async () => {
      await client.add(user("u1"), organization("o1").member);
      await client.add(user("u2"), organization("o1").guest, {
        expiresAt: new Date(),
      });
      await client.add(user.anyone, organization("o1").public_viewer);
      await client.add(team("t1").member, organization("o1").team_member);
      await client.add(organization("o1"), task("tk1").organization);
      await client.remove(user("u1"), organization("o1").member);
    };

    const invalidCalls = async () => {
      // @ts-expect-error -- task instance is not an allowed subject for organization.member
      await client.add(task("tk1"), organization("o1").member);
      // @ts-expect-error -- service actor is not allowed where user actor is required
      await client.add(service("s1"), organization("o1").member);
      // @ts-expect-error -- user actor is not allowed for task.organization parent slot
      await client.add(user("u1"), task("tk1").organization);
      // @ts-expect-error -- team.admin userset is not allowed where team.member userset is required
      await client.add(team("t1").admin, organization("o1").team_member);
      // @ts-expect-error -- task instance is not allowed for remove on organization.member
      await client.remove(task("tk1"), organization("o1").member);
    };

    expect(typeof validCalls).toBe("function");
    expect(typeof invalidCalls).toBe("function");
  });
});
