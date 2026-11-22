import {
  actor,
  anyOf,
  compileAccess,
  every,
  permissionToken,
  resource,
} from "@dads-framework/access";
import { describe, expect, it } from "vitest";

import { compileAccessPolicy } from "./compile-access-policy.js";

describe("compileAccessPolicy", () => {
  it("does not overwrite a user permission when allocating a direct-role wrapper", () => {
    const user = actor("user");
    const note = resource("note", {
      roles: { author: user },
      can: ({ author }) => ({ dads_relation_0: author }),
    });
    const compiled = compileAccessPolicy(compileAccess([user, note]));
    expect(compiled.permissionName(note.wireName, "dads_relation_0")).toBe(
      "dads_relation_0",
    );
    expect(compiled.permissionName(note.wireName, "author")).toBe(
      "dads_relation_1",
    );
    expect(compiled.permissionName(note.wireName, "absent")).toBeUndefined();
  });

  it("refuses a cycle through same-entity permission references", () => {
    const note = resource("note", {
      can: () => ({
        view: [permissionToken("note", "manage")],
        manage: [permissionToken("note", "view")],
      }),
    });
    expect(() => compileAccessPolicy(compileAccess([note]))).toThrow(
      "Cyclic permission reference note#view",
    );
  });

  it("lowers polymorphic arrows across target types that define the permission", () => {
    const user = actor("user");
    const workspace = resource("workspace", {
      roles: { member: user, billing_admin: user },
      can: ({ member, billing_admin }) => ({
        view: member,
        manage_billing: billing_admin,
      }),
    });
    const folder = resource("folder", {
      roles: { viewer: user },
      can: ({ viewer }) => ({ view: viewer }),
    });
    const document = resource("document", {
      roles: { parent: [workspace, folder] },
      can: ({ parent }) => ({
        view: parent.view,
        billing: {
          kind: "through",
          role: parent.$roleToken,
          target: workspace.can.manage_billing,
        },
        strict_view: every(parent).view,
      }),
    });
    const compiled = compileAccessPolicy(
      compileAccess([user, workspace, folder, document]),
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
    const user = actor("user");
    const folder = resource("folder", {
      roles: { viewer: user },
      can: ({ viewer }) => ({ view: viewer }),
    });
    const document = resource("document", {
      roles: { parent: folder },
      can: ({ parent }) => ({
        edit: {
          kind: "through",
          role: parent.$roleToken,
          target: permissionToken("folder", "missing"),
        },
      }),
    });
    expect(() =>
      compileAccessPolicy(compileAccess([user, folder, document])),
    ).toThrow("Unknown arrow target document#parent->missing");
  });

  it("accepts monotonic recursive arrows and rejects non-monotonic cycles", () => {
    const user = actor("user");

    const validFolder = resource("folder", {
      recursive: true,
      roles: { viewer: user },
      can: ({ parent, viewer }) => ({
        view: anyOf(viewer, {
          kind: "through",
          role: parent.$roleToken,
          target: permissionToken("folder", "view"),
        }),
      }),
    });
    expect(() =>
      compileAccessPolicy(compileAccess([user, validFolder])),
    ).not.toThrow();

    const excludingCycle = resource("folder", {
      recursive: true,
      roles: { viewer: user, banned: user },
      can: ({ parent, viewer, banned }) => ({
        view: anyOf(
          viewer,
          anyOf({
            kind: "through",
            role: parent.$roleToken,
            target: permissionToken("folder", "view"),
          }).unless(banned),
        ),
      }),
    });
    expect(() =>
      compileAccessPolicy(compileAccess([user, excludingCycle])),
    ).toThrow(/Non-monotonic permission cycle through excluding/);

    const throughAllCycle = resource("folder", {
      recursive: true,
      roles: { viewer: user },
      can: ({ parent, viewer }) => ({
        view: anyOf(viewer, {
          kind: "through-all",
          role: parent.$roleToken,
          target: permissionToken("folder", "view"),
        }),
      }),
    });
    expect(() =>
      compileAccessPolicy(compileAccess([user, throughAllCycle])),
    ).toThrow(/Non-monotonic permission cycle through through-all/);
  });
});
