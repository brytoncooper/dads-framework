import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { listQuery, sortKeys } from "./list-query.js";
import { paginationQuerySchema } from "./pagination.schema.js";

const LONGHAND_SORT_VALUES = [
  "createdAt",
  "-createdAt",
  "name",
  "-name",
] as const;

const longhandQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  sort: z
    .enum(LONGHAND_SORT_VALUES)
    .default("name")
    .meta({ description: "Sort key; -field sorts descending" }),
});

const batteryQuerySchema = listQuery({
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  sort: sortKeys(["createdAt", "name"]).default("name"),
});

describe("sortKeys", () => {
  it("expands each field into its ascending and descending key", () => {
    expect(sortKeys(["createdAt", "name"]).options).toEqual([
      "createdAt",
      "-createdAt",
      "name",
      "-name",
    ]);
  });

  it("carries the grammar in the type, not only at runtime", () => {
    expectTypeOf<
      z.infer<ReturnType<typeof sortKeys<["name"]>>>
    >().toEqualTypeOf<"name" | "-name">();
  });
});

describe("listQuery", () => {
  it("emits JSON Schema identical to the longhand it replaces", () => {
    expect(z.toJSONSchema(batteryQuerySchema, { io: "input" })).toEqual(
      z.toJSONSchema(longhandQuerySchema, { io: "input" }),
    );
  });

  it("inherits pagination defaults and strictness from the base", () => {
    expect(batteryQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 25,
      sort: "name",
    });
    expect(() => batteryQuerySchema.parse({ nope: 1 })).toThrow();
  });

  it("takes no filters at all, for a collection with none", () => {
    expect(listQuery({}).parse({})).toEqual({ page: 1, perPage: 25 });
  });
});
