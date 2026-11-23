import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorSchema, apiResponseSchema } from "./envelope.schema.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8"));
}

describe("success envelope contract", () => {
  it("parses a captured enveloped resource", () => {
    const schema = apiResponseSchema(z.object({ id: z.uuid(), name: z.string() }));
    expect(() => schema.parse(fixture("enveloped-resource.json"))).not.toThrow();
  });

  it("rejects a payload without data", () => {
    const schema = apiResponseSchema(z.object({}));
    expect(() => schema.parse({ meta: {} })).toThrow();
  });
});

describe("error envelope contract", () => {
  it("parses a captured error payload", () => {
    expect(() => apiErrorSchema.parse(fixture("error-envelope.json"))).not.toThrow();
  });

  it("strips undeclared response fields and keeps structured details", () => {
    const error = {
      code: "INVALID",
      message: "Invalid",
      details: { field: "name" },
    };
    expect(
      apiErrorSchema.parse({
        authorization: "denied",
        error: { ...error, stack: "private" },
      }),
    ).toEqual({ error });
  });

  it("pins the SCREAMING_SNAKE code invariant", () => {
    expect(() =>
      apiErrorSchema.parse({
        error: { code: "not-screaming", message: "nope" },
      }),
    ).toThrow();
  });
});
