import { withDatabase } from "./with-database.js";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client, type Pool } from "pg";
import { createTestPool } from "./create-test-pool.js";
import { recordRetiredDatabaseTouches } from "./global-setup/retired-database-touches.js";
import {
  privateDatabaseName,
  refuseUnverifiableSchemaKeyedRun,
  TEST_DATABASE_RUN_PREFIX,
} from "./global-setup/verify-schema-keyed-suite.js";
import {
  postgresStorageSettings,
  testPostgresStorage,
  withPostgresMemoryLimit,
  withPostgresStorage,
} from "./test-postgres-storage.js";

const execFileAsync = promisify(execFile);

export type TestPostgres = {
  pool: Pool;
  connectionString: string;
  stop: () => Promise<void>;
};

/** Set by `global-setup/index.ts` or `scripts/with-shared-test-postgres.ts`. */
export const SHARED_TEST_POSTGRES_URL = "SHARED_TEST_POSTGRES_URL";
/** Escape hatch: force the old boot-per-file path (the nightly honesty job). */
export const CONTAINER_PER_FILE = "CONTAINER_PER_FILE";
/** The migrated database every per-file database is copied from. */
export const TEMPLATE_DATABASE = "dads_template";

export type StartTestPostgresOptions = {
  /**
   * Whether the returned pool stamps the audit actor on every checkout.
   * Default true, which is what keeps raw seeder and test inserts
   * working now that the `audit_record` trigger refuses unattributed writes.
   * Only a suite proving that refusal wants false — use
   * {@link startUnattributedTestPostgres} to say so by name.
   */
  readonly attributed?: boolean;
  /**
   * The most connections the returned pool opens at once; pg's default (10)
   * when omitted. A suite booting many pools against the shared server caps
   * them under its `SHARED_TEST_POSTGRES_MAX_CONNECTIONS`.
   */
  readonly maxConnections?: number;
};

/**
 * A fully-migrated Postgres for one test file.
 *
 * The PROCESS is shared; the DATA never is. One container per Nx integration
 * run migrates ONCE into a template database. Each caller then gets a private
 * database cloned from that migrated template in milliseconds instead of a
 * container boot plus 21 migrations. Suites still truncate
 * between tests via `truncateTables`, exactly as before, so every suite is as
 * isolated as it was when each one owned a container (docs/testing/speed.md).
 *
 * Falls back to booting a container per file when the shared one is absent —
 * which is what `CONTAINER_PER_FILE=1` forces, and what the nightly job runs
 * to prove the shared path has not started hiding cross-file leakage.
 */
export async function startTestPostgres(options: StartTestPostgresOptions = {}): Promise<TestPostgres> {
  const shared = process.env[SHARED_TEST_POSTGRES_URL];
  if (shared !== undefined && process.env[CONTAINER_PER_FILE] !== "1") {
    return databaseFromTemplate(shared, options);
  }
  return bootOwnContainer(options);
}

/**
 * A migrated Postgres whose pool stamps NOTHING, so a write that reaches the
 * `audit_record` trigger arrives unattributed and is refused. Exactly one
 * suite should want this: the one proving the refusal is real.
 */
export async function startUnattributedTestPostgres(): Promise<TestPostgres> {
  return startTestPostgres({ attributed: false });
}

/** A private empty database for tests that must prove the migration process itself. */
export async function startUnmigratedTestPostgres(options: StartTestPostgresOptions = {}): Promise<TestPostgres> {
  const shared = process.env[SHARED_TEST_POSTGRES_URL];
  if (shared !== undefined && process.env[CONTAINER_PER_FILE] !== "1") {
    return databaseWithoutTemplate(shared, options);
  }
  return bootOwnContainerWithMigration(false, options);
}

/** Per-file honesty path: one container, migrated in place, owned by this file. */
async function bootOwnContainer(options: StartTestPostgresOptions): Promise<TestPostgres> {
  return bootOwnContainerWithMigration(true, options);
}

async function bootOwnContainerWithMigration(
  applyMigrations: boolean,
  options: StartTestPostgresOptions,
): Promise<TestPostgres> {
  refuseUnverifiableSchemaKeyedRun({
    env: process.env,
    containerPerFile: process.env[CONTAINER_PER_FILE] === "1",
    workspaceRoot: findWorkspaceRoot(),
  });
  const storage = testPostgresStorage();
  const container = await withPostgresMemoryLimit(
    withPostgresStorage(
      new PostgreSqlContainer("postgres:16-alpine")
        .withDatabase("dads_test")
        .withCommand(["postgres", ...postgresStorageSettings(storage)]),
      storage,
    ),
    storage,
  ).start();
  const connectionString = container.getConnectionUri();
  const pool = createTestPool(connectionString, options);
  if (applyMigrations) {
    await applyCheckedInSchema(connectionString);
  }

  return {
    pool,
    connectionString,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/** Clone the migrated template into a database only this caller uses. */
async function databaseFromTemplate(sharedUrl: string, options: StartTestPostgresOptions): Promise<TestPostgres> {
  return createPrivateDatabase(sharedUrl, options, TEMPLATE_DATABASE);
}

async function databaseWithoutTemplate(sharedUrl: string, options: StartTestPostgresOptions): Promise<TestPostgres> {
  return createPrivateDatabase(sharedUrl, options);
}

export async function createPrivateDatabase(
  sharedUrl: string,
  options: StartTestPostgresOptions,
  template?: string,
): Promise<TestPostgres> {
  // Underscores and a hex tail: a legal unquoted identifier, and unique even
  // when several files clone at the same instant. The run prefix lets this
  // process's teardown find its own databases among every project's in the
  // shared container (verify-schema-keyed-suite.ts).
  const name = privateDatabaseName(
    process.env[TEST_DATABASE_RUN_PREFIX],
    template !== undefined,
    randomUUID().replaceAll("-", ""),
  );
  const admin = createTestPool(adminUrl(sharedUrl));
  try {
    await admin.query(
      template === undefined ? `CREATE DATABASE "${name}"` : `CREATE DATABASE "${name}" TEMPLATE "${template}"`,
    );
  } finally {
    await admin.end();
  }

  const connectionString = withDatabase(sharedUrl, name);
  const pool = createTestPool(connectionString, options);

  return {
    pool,
    connectionString,
    stop: async () => {
      await pool.end();
      const cleanup = createTestPool(adminUrl(sharedUrl));
      try {
        await retirePrivateDatabase(cleanup, connectionString, name);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * Shut a stopped file's database to every connection, and in RAM drop it.
 *
 * Connections are disallowed BEFORE anything is terminated and never allowed
 * again, so a pool the file leaked cannot reconnect between the terminate pass
 * and the DROP. Nothing may still be connected when the DROP ... WITH (FORCE)
 * runs: it kills what it finds with 57P01, and on a connection nobody listens
 * to that is an uncaught error in whichever test file is stopping.
 * On disk the database is kept until the container goes, to avoid
 * DROP's shared checkpoint; in RAM it is dropped now (test-postgres-storage.ts),
 * after the tables it touched are written to the ledger the schema-keyed
 * teardown reads (retired-database-touches.ts). That read needs a connection
 * to the database, so in RAM the one reader connects first and is spared by
 * the terminate pass.
 */
async function retirePrivateDatabase(admin: Pool, connectionString: string, name: string): Promise<void> {
  const dropNow = await serverKeepsDataInMemory(admin);
  const statsReader = dropNow ? await connectStatsReader(connectionString) : undefined;
  try {
    await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
    // Client backends only. Autovacuum workers ignore ALLOW_CONNECTIONS
    // (they must reach template0), so the launcher can start one here
    // between the terminate pass and the check below — which failed the
    // nightly. A worker vacuuming a database nothing reuses leaks no data.
    const spared = statsReader === undefined ? [] : [statsReader.pid];
    await admin.query(
      "SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend' AND pid <> ALL($2::int[])",
      [name, spared],
    );
    const remaining = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend' AND pid <> ALL($2::int[])",
      [name, spared],
    );
    if (remaining.rows.length > 0) {
      throw new Error(`Test database ${name} still has active connections after termination`);
    }
    if (statsReader !== undefined) {
      // A terminated backend publishes its table counters as it exits, and
      // pg_terminate_backend waited for that exit, so the read sees them.
      await recordRetiredDatabaseTouches(admin, statsReader.client, name);
    }
  } finally {
    // Awaited to the closed socket — unlike Pool.end(), which resolves while
    // its clients are still closing — so the DROP never meets this backend.
    await statsReader?.client.end();
  }
  if (dropNow) {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
}

/** The one connection that reads a database's table counters before its drop. */
async function connectStatsReader(connectionString: string): Promise<{ client: Client; pid: number }> {
  const client = new Client({ connectionString });
  // A failure surfaces as the rejected query; an `error` event with no
  // listener would instead crash the test worker.
  client.on("error", () => undefined);
  await client.connect();
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    await client.end();
    throw new Error("Expected the stats reader's backend pid");
  }
  return { client, pid };
}

/**
 * Whether the server was started with `TEST_POSTGRES_STORAGE=ram`. Asked of
 * the server, not this process's env: a run that attaches to a shared
 * container another run started gets that container's storage, and dropping
 * on a disk-backed server would pay the checkpoint the default avoids.
 */
async function serverKeepsDataInMemory(admin: Pool): Promise<boolean> {
  const result = await admin.query<{ fsync: string }>("SELECT current_setting('fsync') AS fsync");
  return result.rows[0]?.fsync === "off";
}

/** Same server, `postgres` database — the administrative connection. */
function adminUrl(url: string): string {
  return withDatabase(url, "postgres");
}

/** `@dads-framework/postgres/migrations`' runner, run from source so no build is needed. */
const MIGRATE_BIN = "packages/server/postgres/src/migrations/bin/migrate.ts";

export async function applyCheckedInSchema(databaseUrl: string): Promise<void> {
  const workspaceRoot = findWorkspaceRoot();
  await execFileAsync(process.execPath, ["--import", "tsx", join(workspaceRoot, MIGRATE_BIN)], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      WORKSPACE_ROOT: workspaceRoot,
    },
  });
}

/**
 * The root of the checkout this process runs in: the nearest `nx.json`, or the
 * nearest `package.json` that declares `workspaces`.
 */
export function findWorkspaceRoot(): string {
  // Vitest runs with cwd at the project root or workspace root; walk up.
  let dir = process.cwd();
  let parent = dirname(dir);
  while (parent !== dir) {
    if (isWorkspaceRoot(dir)) return dir;
    dir = parent;
    parent = dirname(dir);
  }
  if (isWorkspaceRoot(dir)) {
    return dir;
  }
  throw new Error("Unable to locate the workspace root");
}

function isWorkspaceRoot(dir: string): boolean {
  if (existsSync(join(dir, "nx.json"))) return true;
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed === "object" && parsed !== null && "workspaces" in parsed;
}
