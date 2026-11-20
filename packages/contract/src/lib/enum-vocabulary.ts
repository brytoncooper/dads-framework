import { z } from "zod";

/**
 * One vocabulary: the raw tuple and the Zod enum over it.
 * `VALUES` is shared with Drizzle `text(column, { enum: VALUES })` — a
 * schema-only helper would break the tables. Infer the union at the
 * declaration site: `type X = z.infer<typeof xVocabulary.schema>`.
 */
export function enumVocabulary<
  const TValues extends readonly [string, ...string[]],
>(values: TValues, description: string) {
  return {
    VALUES: values,
    schema: z.enum(values).meta({ description }),
  };
}
