import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { extensibleEnum, openExtensibleEnums } from "./extensible-enum.js";

const surface = extensibleEnum(["maintenance", "people"], "A surface");

describe("extensibleEnum", () => {
  it("accepts only its values on the server", () => {
    expectTypeOf<z.infer<typeof surface>>().toEqualTypeOf<"maintenance" | "people">();
    expect(surface.parse("people")).toBe("people");
    expect(() => surface.parse("orders")).toThrow();
  });

  it("documents its values as x-extensible-enum, never as a closed enum", () => {
    expect(
      z.toJSONSchema(z.object({ surface }), {
        target: "openapi-3.0",
        override: openExtensibleEnums,
      }),
    ).toEqual({
      type: "object",
      properties: {
        surface: {
          type: "string",
          description: "A surface",
          "x-extensible-enum": ["maintenance", "people"],
        },
      },
      required: ["surface"],
      additionalProperties: false,
    });
  });

  it("leaves a closed enum closed", () => {
    expect(
      z.toJSONSchema(z.enum(["A", "B"]), {
        target: "openapi-3.0",
        override: openExtensibleEnums,
      }),
    ).toEqual({ type: "string", enum: ["A", "B"] });
  });
});
