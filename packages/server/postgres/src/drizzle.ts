import type { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";

export type { NodePgDatabase as DrizzleDatabase } from "drizzle-orm/node-postgres";

/**
 * The query handle returned by the native Drizzle factory, without its
 * pool-owned client. Keep the schema inferred from the factory result and
 * preserve the historical unconfigured schema default.
 */
export type DrizzleHandle<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> =
  ReturnType<typeof drizzle<TSchema>> extends NodePgDatabase<infer Schema>
    ? NodePgDatabase<Schema>
    : never;
