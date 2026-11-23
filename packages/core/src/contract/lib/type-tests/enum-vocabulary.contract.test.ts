import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { enumVocabulary } from "../enum-vocabulary.js";

const LONGHAND_VALUES = ["ACTIVE", "ARCHIVED"] as const;
const longhandSchema = z.enum(LONGHAND_VALUES).meta({ description: "Lifecycle status" });

const status = enumVocabulary(["ACTIVE", "ARCHIVED"], "Lifecycle status");

describe("enumVocabulary", () => {
  it("emits JSON Schema identical to the longhand it replaces", () => {
    expect(z.toJSONSchema(status.schema)).toEqual(z.toJSONSchema(longhandSchema));
  });

  it("exposes the raw tuple Drizzle tables import for text(col, { enum })", () => {
    expect(status.VALUES).toEqual(LONGHAND_VALUES);
    expectTypeOf<string>().not.toExtend<z.infer<typeof status.schema>>();
    expectTypeOf(status.VALUES).toEqualTypeOf<readonly ["ACTIVE", "ARCHIVED"]>();
  });

  it("derives the same union type the longhand did", () => {
    expectTypeOf<z.infer<typeof status.schema>>().toEqualTypeOf<"ACTIVE" | "ARCHIVED">();
    expect(status.schema.parse("ACTIVE")).toBe("ACTIVE");
    expect(() => status.schema.parse("DELETED")).toThrow();
  });
});
