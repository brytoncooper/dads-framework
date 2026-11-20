import {
  access,
  accessModel,
  entityHandle,
  permissionToken,
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
});
