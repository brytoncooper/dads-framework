// What/why: readSchema answers "" only for SpiceDB's never-written refusal;
// any other failure must still surface instead of reading as an empty schema.
import { describe, expect, it } from "vitest";

import { isEmptySchemaError } from "./spice-db-empty-schema.js";

describe("isEmptySchemaError", () => {
  it("recognizes SpiceDB's never-written schema refusals", () => {
    expect(isEmptySchemaError(new Error("No schema has been defined"))).toBe(
      true,
    );
    expect(isEmptySchemaError({ message: "schema is empty" })).toBe(true);
  });

  it("does not swallow other failures", () => {
    expect(isEmptySchemaError(new Error("connection refused"))).toBe(false);
    expect(isEmptySchemaError("deadline exceeded")).toBe(false);
  });
});
