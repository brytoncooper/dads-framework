import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { access, entityHandle, type through } from "../../index.js";
import type { PermissionToken } from "../refs.js";

it("keeps entity, role, and permission authoring contracts distinct", () => {
  const person = entityHandle({
    wireName: "sample/person",
    idSchema: z.string(),
  });
  const note = entityHandle({ wireName: "sample/note", idSchema: z.string() });
  const policy = access(note, {
    roles: { author: person },
    permissions: (roles) => ({ view: [roles.author] }),
  });

  expect(policy.roles.author.roleName).toBe("author");
  expectTypeOf<z.ZodNumber>().not.toExtend<
    Parameters<typeof entityHandle>[0]["idSchema"]
  >();
  expectTypeOf<"editor">().not.toExtend<keyof typeof policy.roles>();
  expectTypeOf<"delete">().not.toExtend<keyof typeof policy.permissions>();
  expectTypeOf<string>().not.toExtend<PermissionToken>();
  expectTypeOf<PermissionToken>().not.toExtend<Parameters<typeof through>[0]>();
  expectTypeOf<string>().not.toExtend<Parameters<typeof through>[1]>();
});
