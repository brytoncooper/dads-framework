import { actor, allOf, compileAccess, parseZed, resource } from "@dads-framework/access";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { diffAccessIr, diffAccessModels } from "./diff-access-models.js";

const idSchema = z.string().min(1);
const user = actor("user", { id: idSchema });

describe("diffAccessModels", () => {
  it("reports no changes when two models are semantically identical (ignoring OR order)", () => {
    const docA = resource("document", {
      id: idSchema,
      roles: { owner: user, editor: user },
      can: ({ owner, editor }) => ({ view: [owner, editor] }),
    });
    const docB = resource("document", {
      id: idSchema,
      roles: { owner: user, editor: user },
      can: ({ owner, editor }) => ({ view: [editor, owner] }),
    });

    const diff = diffAccessModels(compileAccess([user, docA]), compileAccess([user, docB]));

    expect(diff.requiresMigration).toBe(false);
    expect(diff.safe).toEqual([]);
    expect(diff.breaking).toEqual([]);
    expect(diff.permissionChanges).toEqual([]);
    expect(diff.summary).toBe("No access model changes.");
  });

  it("classifies added resources, added roles, widened roles, added expiration, and permission changes as safe", () => {
    const groupDef = resource("group", {
      id: idSchema,
      roles: { member: user },
      can: () => ({}),
    });
    const docV1 = resource("document", {
      id: idSchema,
      roles: { viewer: user },
      can: ({ viewer }) => ({ view: viewer }),
    });
    const docV2 = resource("document", {
      id: idSchema,
      roles: {
        viewer: [user.expiring, groupDef.roles.member],
        editor: user,
      },
      can: ({ viewer, editor }) => ({
        view: [viewer, editor],
        edit: editor,
      }),
    });
    const workspaceDef = resource("workspace", {
      id: idSchema,
      roles: { member: user },
      can: ({ member }) => ({ read: member }),
    });

    const diff = diffAccessModels(
      compileAccess([user, groupDef, docV1]),
      compileAccess([user, groupDef, docV2, workspaceDef]),
    );

    expect(diff.requiresMigration).toBe(false);
    expect(diff.breaking).toEqual([]);
    expect(diff.safe).toEqual(
      expect.arrayContaining([
        { kind: "added-resource", resource: "workspace" },
        { kind: "added-role", resource: "document", role: "editor" },
        {
          kind: "widened-role",
          resource: "document",
          role: "viewer",
          subject: "group#member",
        },
        {
          kind: "added-expiration",
          resource: "document",
          role: "viewer",
          subject: "user",
        },
        {
          kind: "added-permission",
          resource: "document",
          permission: "edit",
          expression: "editor",
        },
        {
          kind: "modified-permission",
          resource: "document",
          permission: "view",
          before: "viewer",
          after: "viewer + editor",
        },
      ]),
    );
    expect(diff.permissionChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "modified",
          resource: "document",
          permission: "view",
          description: "Modified permission document#view: viewer -> viewer + editor",
        }),
        expect.objectContaining({
          kind: "added",
          resource: "document",
          permission: "edit",
          description: "Added permission document#edit = editor",
        }),
        expect.objectContaining({
          kind: "added",
          resource: "workspace",
          permission: "read",
          description: "Added permission workspace#read = member",
        }),
      ]),
    );
    expect(diff.summary).toContain("Safe change:");
  });

  it("classifies removed resources, removed roles, narrowed role subject types, and removed expiration as breaking", () => {
    const workspaceV1 = resource("workspace", {
      id: idSchema,
      roles: {
        member: [user.expiring, user.anyone],
        legacy_admin: user,
      },
      can: ({ member, legacy_admin }) => ({
        view: [member, legacy_admin],
      }),
    });
    const docV1 = resource("document", {
      id: idSchema,
      roles: { parent: workspaceV1 },
      can: ({ parent }) => ({
        view: parent.view,
      }),
    });

    const workspaceV2 = resource("workspace", {
      id: idSchema,
      roles: {
        member: user,
      },
      can: ({ member }) => ({
        view: member,
      }),
    });

    const diff = diffAccessModels(compileAccess([user, workspaceV1, docV1]), compileAccess([user, workspaceV2]));

    expect(diff.requiresMigration).toBe(true);
    expect(diff.breaking).toEqual([
      { kind: "removed-resource", resource: "document" },
      { kind: "removed-role", resource: "workspace", role: "legacy_admin" },
      {
        kind: "removed-expiration",
        resource: "workspace",
        role: "member",
        subject: "user",
      },
      {
        kind: "narrowed-role",
        resource: "workspace",
        role: "member",
        subject: "user:*",
      },
    ]);
    expect(diff.summary).toContain("Migration required:");
    expect(diff.summary).toContain("removed resource document");
    expect(diff.summary).toContain("removed role workspace#legacy_admin");
    expect(diff.summary).toContain("removed expiration on workspace#member");
  });

  it("formats exclusions and intersections cleanly in diffAccessIr", () => {
    const beforeIr = parseZed(`
      definition user {}
      definition doc {
        relation editor: user
        relation approved: user
        relation banned: user
        permission publish = editor - banned
      }
    `);
    const afterIr = parseZed(`
      definition user {}
      definition doc {
        relation editor: user
        relation approved: user
        relation banned: user
        permission publish = (editor & approved) - banned
      }
    `);

    const diff = diffAccessIr(beforeIr, afterIr);

    expect(diff.requiresMigration).toBe(false);
    expect(diff.permissionChanges).toHaveLength(1);
    expect(diff.permissionChanges[0]?.description).toBe(
      "Modified permission doc#publish: (editor - banned) -> ((editor & approved) - banned)",
    );
  });

  it("handles removed permissions safely and notes them in permissionChanges", () => {
    const docV1 = resource("document", {
      id: idSchema,
      roles: { editor: user, approved: user },
      can: ({ editor, approved }) => ({
        view: editor,
        publish: allOf(editor, approved),
        safe_view: editor.unless(approved),
      }),
    });
    const docV2 = resource("document", {
      id: idSchema,
      roles: { editor: user, approved: user },
      can: ({ editor }) => ({
        view: editor,
      }),
    });

    const diff = diffAccessModels(compileAccess([user, docV1]), compileAccess([user, docV2]));

    expect(diff.requiresMigration).toBe(false);
    expect(diff.permissionChanges.map((entry) => entry.permission)).toEqual(["publish", "safe_view"]);
  });
});
