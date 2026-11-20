import type { z } from "zod";

/**
 * Brands ids from `Authorization.lookupResources()`. That API stays
 * `readonly string[]` because it addresses resources as a `(type, id)` pair
 * with a runtime type string — branding half the pair buys nothing. Parse
 * (never a cast) so a wrong kind of id fails instead of hiding.
 */
export function parseAuthorizationIds<
  TSchema extends z.ZodType<string, string>,
>(schema: TSchema, ids: readonly string[]): readonly z.output<TSchema>[] {
  return ids.map((id) => schema.parse(id));
}
