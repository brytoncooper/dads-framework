import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { entityIdSchema, mintEntityId, opaqueIdSchema } from "../entity-id.js";

const SAMPLE_V7 = "0192f2a0-0000-7000-8000-000000000000";
const SAMPLE_V4 = "550e8400-e29b-41d4-a716-446655440000";

const alphaIdSchema = entityIdSchema("AlphaId", "An alpha id");
type AlphaId = z.infer<typeof alphaIdSchema>;

const betaIdSchema = entityIdSchema("BetaId", "A beta id");
type BetaId = z.infer<typeof betaIdSchema>;

const subjectIdSchema = opaqueIdSchema("SubjectId", "A subject id");
type SubjectId = z.infer<typeof subjectIdSchema>;

describe("entityIdSchema — nominal typing", () => {
  it("refuses a plain string where a branded id is required", () => {
    expectTypeOf<string>().not.toExtend<AlphaId>();
  });

  it("keeps two brands apart", () => {
    const beta: BetaId = betaIdSchema.parse(SAMPLE_V7);
    expectTypeOf(beta).not.toExtend<AlphaId>();
  });

  it("widens to string freely, so template literals and SQL params keep working", () => {
    const alpha = alphaIdSchema.parse(SAMPLE_V7);
    const widened: string = alpha;
    expect(`/alpha/${encodeURIComponent(alpha)}`).toBe(`/alpha/${widened}`);
  });

  it("brands the output and leaves the input a plain string", () => {
    expectTypeOf<z.input<typeof alphaIdSchema>>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof alphaIdSchema>>().toEqualTypeOf<AlphaId>();
    expect(alphaIdSchema.parse(SAMPLE_V7)).toBe(SAMPLE_V7);
  });

  it("survives .meta() chained at a field site — the erasure guard", () => {
    const referenceSchema = z.strictObject({
      alphaId: alphaIdSchema.meta({ description: "Reference to an alpha" }),
    });
    const parsed = referenceSchema.parse({ alphaId: SAMPLE_V7 });
    expectTypeOf(parsed.alphaId).toEqualTypeOf<AlphaId>();
    expect(parsed.alphaId).toBe(SAMPLE_V7);
  });

  it("survives .optional() and .nullable()", () => {
    expectTypeOf<z.output<ReturnType<typeof alphaIdSchema.optional>>>().toEqualTypeOf<AlphaId | undefined>();
    expectTypeOf<z.output<ReturnType<typeof alphaIdSchema.nullable>>>().toEqualTypeOf<AlphaId | null>();
    expect(alphaIdSchema.nullable().parse(null)).toBeNull();
  });
});

describe("entityIdSchema — runtime", () => {
  it("pins UUID v7 (ADR-0012) and rejects a v4", () => {
    expect(alphaIdSchema.parse(SAMPLE_V7)).toBe(SAMPLE_V7);
    expect(() => alphaIdSchema.parse(SAMPLE_V4)).toThrow();
  });

  it("emits JSON Schema byte-identical to the unbranded schema", () => {
    expect(z.toJSONSchema(entityIdSchema("AlphaId", "An alpha id"))).toEqual(
      z.toJSONSchema(z.uuidv7().meta({ description: "An alpha id" })),
    );
  });
});

describe("opaqueIdSchema — ids this repo does not mint", () => {
  it("accepts a non-UUID subject id and rejects an empty one", () => {
    expect(subjectIdSchema.parse("auth0|abc")).toBe("auth0|abc");
    expect(() => subjectIdSchema.parse("")).toThrow();
  });

  it("still brands, and stays apart from an entity id", () => {
    const subject: SubjectId = subjectIdSchema.parse("auth0|abc");
    expectTypeOf(subject).not.toExtend<AlphaId>();
  });

  it("emits JSON Schema byte-identical to the unbranded schema", () => {
    expect(z.toJSONSchema(opaqueIdSchema("SubjectId", "A subject id"))).toEqual(
      z.toJSONSchema(z.string().min(1).meta({ description: "A subject id" })),
    );
  });
});

describe("mintEntityId", () => {
  it("mints a branded, schema-valid id", () => {
    const alpha = mintEntityId(alphaIdSchema);
    expectTypeOf(alpha).toEqualTypeOf<AlphaId>();
    expect(() => alphaIdSchema.parse(alpha)).not.toThrow();
  });

  it("mints under the brand of the schema it was given", () => {
    const beta = mintEntityId(betaIdSchema);
    expectTypeOf(beta).toEqualTypeOf<BetaId>();
    expectTypeOf(beta).not.toExtend<AlphaId>();
    expect(() => betaIdSchema.parse(beta)).not.toThrow();
  });
});
