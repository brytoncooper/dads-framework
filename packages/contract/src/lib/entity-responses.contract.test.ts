import { describe, expect, it } from "vitest";
import { z } from "zod";
import { entityResponses } from "./entity-responses.js";
import { apiResponseSchema } from "./envelope.schema.js";
import { paginatedResponseSchema } from "./pagination.schema.js";

const thingSchema = z
  .strictObject({ id: z.uuidv7(), name: z.string().min(1) })
  .meta({ description: "A thing" });

const responses = entityResponses(thingSchema);

describe("entityResponses", () => {
  it("emits JSON Schema identical to the two longhand wrappers", () => {
    expect(z.toJSONSchema(responses.one, { io: "output" })).toEqual(
      z.toJSONSchema(apiResponseSchema(thingSchema), { io: "output" }),
    );
    expect(z.toJSONSchema(responses.list, { io: "output" })).toEqual(
      z.toJSONSchema(paginatedResponseSchema(thingSchema), { io: "output" }),
    );
  });

  it("parses a single-resource envelope and a page", () => {
    const thing = { id: "0192f2a0-0000-7000-8000-000000000000", name: "one" };
    expect(responses.one.parse({ data: thing }).data.name).toBe("one");
    expect(
      responses.list.parse({
        data: [thing],
        meta: { total: 1, page: 1, perPage: 25 },
      }).data,
    ).toHaveLength(1);
  });

  it("still STRIPS on the way out, which is what stops a wide row leaking", () => {
    const wideResponses = entityResponses(
      z.object({ id: z.uuidv7(), name: z.string().min(1) }),
    );
    const parsed = wideResponses.one.parse({
      data: {
        id: "0192f2a0-0000-7000-8000-000000000000",
        name: "one",
        secret: "do-not-ship",
      },
      unexpected: "also dropped",
    });
    expect(parsed.data).not.toHaveProperty("secret");
    expect(parsed).not.toHaveProperty("unexpected");
  });
});
