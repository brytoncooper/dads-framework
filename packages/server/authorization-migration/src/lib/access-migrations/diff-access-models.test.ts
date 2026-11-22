import {
  access,
  accessModel,
  both,
  entityHandle,
  excluding,
  membersOf,
  parseZed,
  through,
  wildcard,
  withExpiration,
} from "@dads-framework/access";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { diffAccessIr, diffAccessModels } from "./diff-access-models.js";

const idSchema = z.string().min(1);
const user = entityHandle({ wireName: "user", idSchema });
const group = entityHandle({ wireName: "group", idSchema });
const workspace = entityHandle({ wireName: "workspace", idSchema });
const document = entityHandle({ wireName: "document", idSchema });

describe("diffAccessModels", () => {
  it("reports no changes when two models are semantically identical (ignoring OR order)", () => {
    const userDef = access(user, { roles: {}, permissions: () => ({}) });
    const docA = access(document, {
      roles: { owner: user, editor: user },
      permissions: ({ owner, editor }) => ({ view: [owner, editor] }),
    });
    const docB = access(document, {
      roles: { owner: user, editor: user },
      permissions: ({ owner, editor }) => ({ view: [editor, owner] }),
    });

    const diff = diffAccessModels(
      accessModel([userDef, docA]),
      accessModel([userDef, docB]),
    );

    expect(diff.requiresMigration).toBe(false);
    expect(diff.safe).toEqual([]);
    expect(diff.breaking).toEqual([]);
    expect(diff.permissionChanges).toEqual([]);
    expect(diff.summary).toBe("No access model changes.");
  });

  it("classifies added resources, added roles, widened roles, added expiration, and permission changes as safe", () => {
    const userDef = access(user, { roles: {}, permissions: () => ({}) });
    const groupDef = access(group, {
      roles: { member: user },
      permissions: () => ({}),
    });
    const docV1 = access(document, {
      roles: { viewer: user },
      permissions: ({ viewer }) => ({ view: [viewer] }),
    });
    const docV2 = access(document, {
      roles: {
        viewer: [withExpiration(user), membersOf(groupDef.roles.member)],
        editor: user,
      },
      permissions: ({ viewer, editor }) => ({
        view: [viewer, editor],
        edit: [editor],
      }),
    });
    const workspaceDef = access(workspace, {
      roles: { member: user },
      permissions: ({ member }) => ({ read: [member] }),
    });

    const diff = diffAccessModels(
      accessModel([userDef, groupDef, docV1]),
      accessModel([userDef, groupDef, docV2, workspaceDef]),
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
          description:
            "Modified permission document#view: viewer -> viewer + editor",
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
    const userDef = access(user, { roles: {}, permissions: () => ({}) });
    const workspaceV1 = access(workspace, {
      roles: {
        member: [withExpiration(user), wildcard(user)],
        legacy_admin: user,
      },
      permissions: ({ member, legacy_admin }) => ({
        view: [member, legacy_admin],
      }),
    });
    const docV1 = access(document, {
      roles: { parent: workspace },
      permissions: ({ parent }) => ({
        view: [through(parent, workspaceV1.permissions.view)],
      }),
    });

    const workspaceV2 = access(workspace, {
      roles: {
        member: user,
      },
      permissions: ({ member }) => ({
        view: [member],
      }),
    });

    const diff = diffAccessModels(
      accessModel([userDef, workspaceV1, docV1]),
      accessModel([userDef, workspaceV2]),
    );

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
    const userDef = access(user, { roles: {}, permissions: () => ({}) });
    const docV1 = access(document, {
      roles: { editor: user, approved: user },
      permissions: ({ editor, approved }) => ({
        view: [editor],
        publish: [both(editor, approved)],
        safe_view: [excluding(editor, approved)],
      }),
    });
    const docV2 = access(document, {
      roles: { editor: user, approved: user },
      permissions: ({ editor }) => ({
        view: [editor],
      }),
    });

    const diff = diffAccessModels(
      accessModel([userDef, docV1]),
      accessModel([userDef, docV2]),
    );

    expect(diff.requiresMigration).toBe(false);
    expect(diff.permissionChanges.map((entry) => entry.permission)).toEqual([
      "publish",
      "safe_view",
    ]);
  });
});
