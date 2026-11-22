import {
  access,
  accessModel,
  entityHandle,
  excluding,
  permissionToken,
  through,
  throughAll,
} from "@dads-framework/access";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileAccessPolicy } from "./compile-access-policy.js";

describe("compileAccessPolicy", () => {
  it("does not overwrite a user permission when allocating a direct-role wrapper", () => {
    const user = entityHandle({ wireName: "user", idSchema: z.string() });
    const note = entityHandle({ wireName: "note", idSchema: z.string() });
    const userAccess = access(user, { roles: {}, permissions: () => ({}) });
    const noteAccess = access(note, {
      roles: { author: user },
      permissions: ({ author }) => ({ dads_relation_0: [author] }),
    });
    const compiled = compileAccessPolicy(accessModel([userAccess, noteAccess]));
    expect(compiled.permissionName(note.wireName, "dads_relation_0")).toBe(
      "dads_relation_0",
    );
    expect(compiled.permissionName(note.wireName, "author")).toBe(
      "dads_relation_1",
    );
    expect(compiled.permissionName(note.wireName, "absent")).toBeUndefined();
  });

  it("refuses a cycle through same-entity permission references", () => {
    const note = entityHandle({ wireName: "note", idSchema: z.string() });
    const definition = access(note, {
      roles: {},
      permissions: () => ({
        view: [permissionToken(note.wireName, "manage")],
        manage: [permissionToken(note.wireName, "view")],
      }),
    });
    expect(() => compileAccessPolicy(accessModel([definition]))).toThrow(
      "Cyclic permission reference note#view",
    );
  });

  it("lowers polymorphic arrows across target types that define the permission", () => {
    const user = entityHandle({ wireName: "user", idSchema: z.string() });
    const workspace = entityHandle({
      wireName: "workspace",
      idSchema: z.string(),
    });
    const folder = entityHandle({ wireName: "folder", idSchema: z.string() });
    const document = entityHandle({
      wireName: "document",
      idSchema: z.string(),
    });
    const workspaceAccess = access(workspace, {
      roles: { member: user, billing_admin: user },
      permissions: ({ member, billing_admin }) => ({
        view: [member],
        manage_billing: [billing_admin],
      }),
    });
    const folderAccess = access(folder, {
      roles: { viewer: user },
      permissions: ({ viewer }) => ({ view: [viewer] }),
    });
    const documentAccess = access(document, {
      roles: { parent: [workspace, folder] },
      permissions: ({ parent }) => ({
        view: [through(parent, workspaceAccess.permissions.view)],
        billing: [through(parent, workspaceAccess.permissions.manage_billing)],
        strict_view: [throughAll(parent, workspaceAccess.permissions.view)],
      }),
    });
    const compiled = compileAccessPolicy(
      accessModel([
        access(user, { roles: {}, permissions: () => ({}) }),
        workspaceAccess,
        folderAccess,
        documentAccess,
      ]),
    );
    const docView = compiled.model.permissions.find(
      (entry) => entry.entity === "document" && entry.wireName === "view",
    );
    const docBilling = compiled.model.permissions.find(
      (entry) => entry.entity === "document" && entry.wireName === "billing",
    );
    const docStrict = compiled.model.permissions.find(
      (entry) =>
        entry.entity === "document" && entry.wireName === "strict_view",
    );
    expect(docView?.expression).toEqual({
      kind: "through",
      relation: "parent",
      permission: "view",
      targets: [
        { entity: "workspace", permission: "view" },
        { entity: "folder", permission: "view" },
      ],
    });
    expect(docBilling?.expression).toEqual({
      kind: "through",
      relation: "parent",
      permission: "manage_billing",
      targets: [{ entity: "workspace", permission: "manage_billing" }],
    });
    expect(docStrict?.expression).toEqual({
      kind: "through-all",
      relation: "parent",
      permission: "view",
      targets: [
        { entity: "workspace", permission: "view" },
        { entity: "folder", permission: "view" },
      ],
    });
  });

  it("throws when no target type of a polymorphic arrow defines the permission", () => {
    const user = entityHandle({ wireName: "user", idSchema: z.string() });
    const folder = entityHandle({ wireName: "folder", idSchema: z.string() });
    const document = entityHandle({
      wireName: "document",
      idSchema: z.string(),
    });
    const folderAccess = access(folder, {
      roles: { viewer: user },
      permissions: ({ viewer }) => ({ view: [viewer] }),
    });
    const documentAccess = access(document, {
      roles: { parent: folder },
      permissions: ({ parent }) => ({
        edit: [through(parent, permissionToken(folder.wireName, "missing"))],
      }),
    });
    expect(() =>
      compileAccessPolicy(
        accessModel([
          access(user, { roles: {}, permissions: () => ({}) }),
          folderAccess,
          documentAccess,
        ]),
      ),
    ).toThrow("Unknown arrow target document#parent->missing");
  });

  it("accepts monotonic recursive arrows and rejects non-monotonic cycles", () => {
    const user = entityHandle({ wireName: "user", idSchema: z.string() });
    const folder = entityHandle({ wireName: "folder", idSchema: z.string() });
    const userAccess = access(user, { roles: {}, permissions: () => ({}) });

    const validFolder = access(folder, {
      roles: { parent: folder, viewer: user },
      permissions: ({ parent, viewer }) => ({
        view: [
          viewer,
          through(parent, permissionToken(folder.wireName, "view")),
        ],
      }),
    });
    expect(() =>
      compileAccessPolicy(accessModel([userAccess, validFolder])),
    ).not.toThrow();

    const excludingCycle = access(folder, {
      roles: { parent: folder, viewer: user, banned: user },
      permissions: ({ parent, viewer, banned }) => ({
        view: [
          viewer,
          excluding(
            through(parent, permissionToken(folder.wireName, "view")),
            banned,
          ),
        ],
      }),
    });
    expect(() =>
      compileAccessPolicy(accessModel([userAccess, excludingCycle])),
    ).toThrow(/Non-monotonic permission cycle through excluding/);

    const throughAllCycle = access(folder, {
      roles: { parent: folder, viewer: user },
      permissions: ({ parent, viewer }) => ({
        view: [
          viewer,
          throughAll(parent, permissionToken(folder.wireName, "view")),
        ],
      }),
    });
    expect(() =>
      compileAccessPolicy(accessModel([userAccess, throughAllCycle])),
    ).toThrow(/Non-monotonic permission cycle through through-all/);
  });
});
