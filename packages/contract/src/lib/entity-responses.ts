import type { z } from "zod";
import { apiResponseSchema } from "./envelope.schema.js";
import { paginatedResponseSchema } from "./pagination.schema.js";

/**
 * Single-resource and paginated envelopes for one entity schema.
 * Both strip unknown keys: the route kit parses handler returns and
 * throws `ResponseDriftError` on failure, so stripping is what stops a
 * wider Drizzle row leaking a column. Strict on the way in, strip on the way out.
 */
export function entityResponses<TSchema extends z.ZodType>(schema: TSchema) {
  return {
    one: apiResponseSchema(schema),
    list: paginatedResponseSchema(schema),
  };
}
