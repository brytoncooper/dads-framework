/** Recursive schemas must retain valid references when embedded in OpenAPI. */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { schemaComponents } from "./schema-components.js";

describe("schemaComponents", () => {
  it("moves local definitions into distinct components and rewrites recursive references", () => {
    const schema = z.toJSONSchema(z.object({ value: z.json() }), {
      target: "openapi-3.0",
    });
    const components = schemaComponents(
      new Map([
        ["Body", schema],
        ["Other", schema],
      ]),
    );
    expect(components["Body"]).not.toHaveProperty("definitions");
    expect(components["Body"]).toHaveProperty("properties.value.$ref", "#/components/schemas/Body___schema0");
    expect(components["Other"]).toHaveProperty("properties.value.$ref", "#/components/schemas/Other___schema0");
    expect(JSON.stringify(components)).not.toContain("#/definitions/");
    expect(components["Body___schema0"]).toHaveProperty("anyOf");
  });

  it("keeps recursive references to the schema root inside its component", () => {
    const components = schemaComponents(new Map([["Json", { anyOf: [{ type: "array", items: { $ref: "#" } }] }]]));
    expect(components["Json"]).toEqual({
      anyOf: [{ type: "array", items: { $ref: "#/components/schemas/Json" } }],
    });
  });
});
