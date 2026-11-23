import { z } from "zod";

export const PAGINATION_DEFAULT_PER_PAGE = 25;
export const PAGINATION_MAX_PER_PAGE = 100;

/**
 * Collection query pagination (api-conventions.md#pagination).
 * Strict: an unmodelled parameter is 400, not a silent strip. `.extend()`
 * preserves that. Query params are exploded into per-property OpenAPI
 * parameters, never a component schema.
 */
export const paginationQuerySchema = z.strictObject({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .meta({ description: "1-based page number" }),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION_MAX_PER_PAGE)
    .default(PAGINATION_DEFAULT_PER_PAGE)
    .meta({ description: "Items per page (max 100)" }),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// response-shape: returned page metadata keeps its declared fields; list handlers may extend it.
export const paginationMetaSchema = z.object({
  total: z
    .number()
    .int()
    .min(0)
    .meta({ description: "Total items across all pages" }),
  page: z.number().int().min(1).meta({ description: "Current 1-based page" }),
  perPage: z.number().int().min(1).meta({ description: "Items per page" }),
});

export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/** Success envelope for a page of `itemSchema`. */
export function paginatedResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z
      .array(itemSchema)
      .meta({ description: "The requested page of the collection" }),
    meta: paginationMetaSchema.meta({
      description: "Pagination metadata (total, page, perPage)",
    }),
  });
}
