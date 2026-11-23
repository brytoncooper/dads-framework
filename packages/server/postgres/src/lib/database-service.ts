import { defineService, providePlugin, type Plugin } from "@dads-framework/core/plugin";

import type { DrizzleHandle } from "../drizzle.js";
import {
  createPostgresConnection,
  type CreatePostgresConnectionOptions,
  type PostgresConnection,
  type PostgresPoolErrorLog,
} from "./create-postgres-connection.js";

/** The PostgreSQL connection pool handle exposed by `createPostgresConnection`. */
export type PgPool = PostgresConnection["pool"];

/** Narrow capability token for Drizzle database queries and transactions. */
export const databaseService = defineService("database").ofType<DrizzleHandle>();

/** Narrow capability token for raw PostgreSQL pool access. */
export const postgresPoolService = defineService("postgres-pool").ofType<PgPool>();

export type ProvidePostgresDatabaseOptions<Name extends string = "postgres-database"> = Omit<
  CreatePostgresConnectionOptions,
  "schema"
> & {
  /** Runtime Drizzle schema. Defaults to `{}`. */
  readonly schema?: Record<string, unknown>;
  /** Pool error logger. Defaults to `console`. */
  readonly log?: PostgresPoolErrorLog;
  /** Plugin name in the composition. Defaults to `"postgres-database"`. */
  readonly name?: Name;
};

/**
 * Open a managed PostgreSQL connection and provide `databaseService` to a plugin composition.
 * Registers `connection.close` on the plugin scope so the pool ends when the composition stops.
 */
export function providePostgresDatabase(
  options: ProvidePostgresDatabaseOptions,
): Plugin<"postgres-database", never, DrizzleHandle & { $client: PgPool }, never, never, never, "database", never>;
export function providePostgresDatabase<const Name extends string>(
  options: ProvidePostgresDatabaseOptions<Name> & { readonly name: Name },
): Plugin<Name, never, DrizzleHandle & { $client: PgPool }, never, never, never, "database", never>;
export function providePostgresDatabase(
  options: ProvidePostgresDatabaseOptions<string>,
): Plugin<string, never, DrizzleHandle & { $client: PgPool }, never, never, never, "database", never> {
  const { name = "postgres-database", log = console, schema = {}, ...connectionOptions } = options;
  return providePlugin(name, databaseService, (scope) => {
    const connection = createPostgresConnection({ ...connectionOptions, schema }, log);
    scope.onDispose(connection.close);
    return connection.drizzle;
  });
}
