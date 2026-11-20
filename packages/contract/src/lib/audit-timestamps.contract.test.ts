import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditTimestamps } from "./audit-timestamps.js";

const longhandSchema = z
  .strictObject({
    createdAt: z.iso
      .datetime()
      .meta({ description: "Creation (ISO 8601 UTC)" }),
    updatedAt: z.iso
      .datetime()
      .meta({ description: "Last update (ISO 8601 UTC)" }),
  })
  .meta({ description: "An entity" });

const batterySchema = z
  .strictObject({ ...auditTimestamps })
  .meta({ description: "An entity" });

describe("auditTimestamps", () => {
  it("emits JSON Schema identical to the longhand it replaces", () => {
    expect(z.toJSONSchema(batterySchema, { io: "output" })).toEqual(
      z.toJSONSchema(longhandSchema, { io: "output" }),
    );
    expect(z.toJSONSchema(batterySchema, { io: "input" })).toEqual(
      z.toJSONSchema(longhandSchema, { io: "input" }),
    );
  });

  it("parses ISO instants and rejects a bare date", () => {
    expect(
      batterySchema.parse({
        createdAt: "2026-07-11T14:00:00.000Z",
        updatedAt: "2026-07-11T14:00:00.000Z",
      }).createdAt,
    ).toBe("2026-07-11T14:00:00.000Z");
    expect(() =>
      batterySchema.parse({ createdAt: "2026-07-11", updatedAt: "2026-07-11" }),
    ).toThrow();
  });
});
