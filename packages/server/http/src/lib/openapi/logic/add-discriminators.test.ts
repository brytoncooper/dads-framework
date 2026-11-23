import { describe, expect, it } from "vitest";
import { z } from "zod";

import { addDiscriminators } from "./add-discriminators.js";

function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, { target: "openapi-3.0" });
  return { ...converted };
}

function documentWith(
  schemas: Record<string, Record<string, unknown>>,
  paths: Record<string, unknown> = {},
): Record<string, unknown> {
  return { openapi: "3.0.0", paths, components: { schemas } };
}

function componentNames(document: Record<string, unknown>): string[] {
  const components = document["components"];
  if (typeof components !== "object" || components === null) return [];
  const schemas: unknown = Reflect.get(components, "schemas");
  return typeof schemas === "object" && schemas !== null ? Object.keys(schemas) : [];
}

const timeSchedule = z.object({
  basis: z.literal("time"),
  intervalSeconds: z.number(),
});
const meterSchedule = z.object({
  basis: z.literal("meter"),
  meterId: z.string(),
});

describe("addDiscriminators", () => {
  it("tags a discriminated union and moves each branch into a named component", () => {
    const document = documentWith({
      TaskResponse: schemaOf(
        z.object({
          schedule: z.discriminatedUnion("basis", [timeSchedule, meterSchedule]),
        }),
      ),
    });

    const tagged = addDiscriminators(document);

    expect(tagged).toHaveProperty(["components", "schemas", "TaskResponse", "properties", "schedule"], {
      oneOf: [
        { $ref: "#/components/schemas/TaskResponseScheduleTime" },
        { $ref: "#/components/schemas/TaskResponseScheduleMeter" },
      ],
      discriminator: {
        propertyName: "basis",
        mapping: {
          time: "#/components/schemas/TaskResponseScheduleTime",
          meter: "#/components/schemas/TaskResponseScheduleMeter",
        },
      },
    });
    expect(tagged).toHaveProperty(
      ["components", "schemas", "TaskResponseScheduleMeter", "required"],
      ["basis", "meterId"],
    );
  });

  it("turns a tagged anyOf into a oneOf and keeps its nullability", () => {
    const document = documentWith({
      Task: schemaOf(
        z.object({
          schedule: z.union([timeSchedule, meterSchedule]).nullable(),
        }),
      ),
    });

    const tagged = addDiscriminators(document);
    const schedule = ["components", "schemas", "Task", "properties", "schedule"];

    expect(tagged).not.toHaveProperty([...schedule, "anyOf"]);
    expect(tagged).toHaveProperty([...schedule, "nullable"], true);
    expect(tagged).toHaveProperty([...schedule, "discriminator", "propertyName"], "basis");
  });

  it("names array items and upper-case tag values readably", () => {
    const document = documentWith({
      Contexts: schemaOf(
        z.array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("PLATFORM_WORK_ASSIGNMENT") }),
            z.object({ type: z.literal("FACILITY"), facilityId: z.string() }),
          ]),
        ),
      ),
    });

    expect(componentNames(addDiscriminators(document))).toEqual([
      "Contexts",
      "ContextsItemPlatformWorkAssignment",
      "ContextsItemFacility",
    ]);
  });

  it("tags unions inside an operation's inline schemas", () => {
    const document = documentWith(
      {},
      {
        "/tasks": {
          get: {
            operationId: "getTasks",
            parameters: [
              {
                name: "filter",
                in: "query",
                schema: schemaOf(z.discriminatedUnion("basis", [timeSchedule, meterSchedule])),
              },
            ],
            responses: { "200": { description: "" } },
          },
        },
      },
    );

    const tagged = addDiscriminators(document);

    expect(tagged).toHaveProperty(
      ["paths", "/tasks", "get", "parameters", "0", "schema", "discriminator", "mapping", "time"],
      "#/components/schemas/GetTasksFilterParameterTime",
    );
  });

  it("keeps branches that are already component references", () => {
    const document = documentWith({
      Time: schemaOf(timeSchedule),
      Meter: schemaOf(meterSchedule),
      Task: {
        type: "object",
        properties: {
          schedule: {
            oneOf: [{ $ref: "#/components/schemas/Time" }, { $ref: "#/components/schemas/Meter" }],
          },
        },
      },
    });

    expect(addDiscriminators(document)).toHaveProperty(
      ["components", "schemas", "Task", "properties", "schedule", "discriminator", "mapping"],
      {
        time: "#/components/schemas/Time",
        meter: "#/components/schemas/Meter",
      },
    );
  });

  it("leaves a union of plain values alone", () => {
    const document = documentWith({
      Flag: schemaOf(z.union([z.string(), z.boolean()])),
    });

    expect(addDiscriminators(document)).toEqual(document);
  });

  it("refuses a oneOf whose branches share no tag, naming where it is", () => {
    const document = documentWith({
      Shape: {
        oneOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
    });

    expect(() => addDiscriminators(document)).toThrow(/no type tag: Shape\./);
  });

  it("refuses a branch name an existing component already holds", () => {
    const document = documentWith({
      Task: schemaOf(
        z.object({
          schedule: z.discriminatedUnion("basis", [timeSchedule, meterSchedule]),
        }),
      ),
      TaskScheduleTime: { type: "string" },
    });

    expect(() => addDiscriminators(document)).toThrow(/"TaskScheduleTime" already exists/);
  });
});
