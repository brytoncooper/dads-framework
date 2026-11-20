import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createAttributedPool,
  type AuditActorSource,
} from "./attributed-pool.js";
import { listenForCheckedOutClientErrors } from "./checked-out-client-errors.js";

export type CreatePostgresConnectionOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Runtime Drizzle schema, assembled by the composition root from domain exports. */
  readonly schema: TSchema;
  /** Postgres connection string from the validated environment. */
  readonly connectionString: string;
  /**
   * Where the pool reads the audit actor on every checkout. Given
   * one, the returned `pool` IS the attributed pool, so the raw-pool consumers
   * that share it — `PostgresOwnerLock`, the participant coordinator, the
   * Better Auth adapter — are attributed by construction rather than by
   * remembering to be.
   *
   * Optional because the migrator and the schema generator build connections
   * that run DDL against databases whose audit trigger does not exist yet.
   */
  readonly auditActorSource?: AuditActorSource;
  /**
   * The most connections this pool opens at once. Omitted, pg's own default
   * (10) applies, which is what every deployed process runs. Tests that boot
   * many apps against one shared Postgres pass a smaller number so the sum
   * of their pools fits under its `max_connections`.
   */
  readonly maxConnections?: number;
  /**
   * Settings every connection of this pool starts with, sent as Postgres
   * startup options (`-c name=value`), so they hold from a connection's first
   * statement and no checkout can miss them. Omitted, connections start with
   * none. Names and values are plain words (letters, digits, `_`, `.`); any
   * other refuses the construction, since a startup option cannot carry a
   * space unescaped. A connection string that names its own `options`
   * overrides these (pg lets the string win), so callers pass none there.
   */
  readonly sessionSettings?: Readonly<Record<string, string>>;
};

export type PostgresConnection<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly pool: Pool;
  readonly drizzle: NodePgDatabase<TSchema> & { $client: Pool };
  /** Ends the pool — wired into app shutdown by the composition root. */
  readonly close: () => Promise<void>;
};

export type PostgresPoolErrorLog = {
  error(obj: object, msg?: string): void;
};

/**
 * The one Drizzle/pg construction point. Generic over the schema so the
 * composition root's handle keeps its table types.
 *
 * Two process-discipline walls live here: client errors are LOGGED, never
 * left unlistened — an unlistened 'error' event kills the process (the
 * classic Node/pg crash). pg emits an idle client's error on the pool and a
 * checked-out client's on the client itself, so both are listened for. And
 * close() is idempotent so teardown paths can never trip "end called twice".
 *
 * With `auditActorSource`, the pool it builds stamps the current actor onto
 * every checkout. One pool object serves Drizzle and the raw-pool
 * consumers, so attribution is a property of the connection rather than
 * something 61 writer files have to remember.
 */
export function createPostgresConnection<
  TSchema extends Record<string, unknown>,
>(
  options: CreatePostgresConnectionOptions<TSchema>,
  log: PostgresPoolErrorLog,
): PostgresConnection<TSchema> {
  const poolConfig = {
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined
      ? {}
      : { max: options.maxConnections }),
    ...(options.sessionSettings === undefined
      ? {}
      : { options: startupOptionsOf(options.sessionSettings) }),
  };
  const pool =
    options.auditActorSource === undefined
      ? new Pool(poolConfig)
      : createAttributedPool(poolConfig, options.auditActorSource);
  pool.on("error", (error) => {
    log.error(
      { event: "database.idle-client-error", err: error },
      "idle postgres client errored (connection dropped)",
    );
  });
  listenForCheckedOutClientErrors(pool, (error) => {
    log.error(
      { event: "database.checked-out-client-error", err: error },
      "checked-out postgres client errored (connection dropped)",
    );
  });
  const drizzleHandle = drizzle(pool, { schema: options.schema });
  let ended = false;
  return {
    pool,
    drizzle: drizzleHandle,
    close: () => {
      if (ended) return Promise.resolve();
      ended = true;
      return pool.end();
    },
  };
}

const PLAIN_SETTING_WORD = /^[A-Za-z0-9_.]+$/;

/**
 * `{ "a.b": "on" }` → `-c a.b=on`: the startup options that set each
 * setting on a new connection. Refuses a name or value that is not a plain
 * word, rather than escape it.
 */
function startupOptionsOf(settings: Readonly<Record<string, string>>): string {
  return Object.entries(settings)
    .map(([name, value]) => {
      if (!PLAIN_SETTING_WORD.test(name) || !PLAIN_SETTING_WORD.test(value)) {
        throw new Error(
          `Session setting ${JSON.stringify(name)} = ${JSON.stringify(value)} is not a plain word (letters, digits, _ and . only).`,
        );
      }
      return `-c ${name}=${value}`;
    })
    .join(" ");
}
