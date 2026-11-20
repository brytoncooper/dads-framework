import { describe, expect, it } from "vitest";
import { z } from "zod";

import { expectedRowVersionFields, rowVersionSchema } from "./row-version.js";

const save = z.strictObject({ title: z.string(), ...expectedRowVersionFields });

describe("row version contract", () => {
  it("requires a row version on the write and keeps it as a number", () => {
    expect(save.parse({ title: "Draft", expectedRowVersion: 1 })).toEqual({
      title: "Draft",
      expectedRowVersion: 1,
    });
    expect(save.safeParse({ title: "Draft" }).success).toBe(false);
  });

  it.each([-1, 0.5, "1", 2_147_483_648])(
    "rejects invalid revision %s",
    (input) => {
      expect(rowVersionSchema.safeParse(input).success).toBe(false);
    },
  );
});
