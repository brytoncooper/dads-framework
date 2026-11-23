import { createPostgresConnection } from "@dads-framework/postgres";
import type { ApplyAuthorizationSchemaLog } from "@dads-framework/access/schema";

const PREVIOUS_DATABASE = "spicedb_previous";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function cloneSpiceDbDatastore(input: {
  adminUrl: string;
  sourceDatabase: string;
  log?: ApplyAuthorizationSchemaLog;
}): Promise<"cloned" | "skipped"> {
  if (!IDENTIFIER.test(input.sourceDatabase)) {
    throw new Error("SpiceDB datastore database name is not a SQL identifier");
  }

  const connection = createPostgresConnection(
    { connectionString: input.adminUrl, schema: {}, maxConnections: 1 },
    {
      error: (context, message) =>
        input.log?.info(
          context,
          message ?? "Postgres snapshot connection error",
        ),
    },
  );
  try {
    await connection.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [PREVIOUS_DATABASE],
    );
    await connection.pool.query(`DROP DATABASE IF EXISTS ${PREVIOUS_DATABASE}`);
    await connection.pool.query(
      `CREATE DATABASE ${PREVIOUS_DATABASE} TEMPLATE ${input.sourceDatabase}`,
    );
    input.log?.info(
      {
        event: "authorization.schema.snapshot.cloned",
        code: "AUTHORIZATION_SCHEMA_SNAPSHOT_CLONED",
        database: PREVIOUS_DATABASE,
      },
      "cloned the SpiceDB datastore before contracting leftover tuples",
    );
    return "cloned";
  } catch (error: unknown) {
    input.log?.info(
      {
        event: "authorization.schema.snapshot.skipped",
        code: "AUTHORIZATION_SCHEMA_SNAPSHOT_SKIPPED",
        cause: error instanceof Error ? error.name : "UnknownError",
      },
      "could not clone the SpiceDB datastore; continuing without a rolling snapshot",
    );
    return "skipped";
  } finally {
    await connection.close().catch(() => undefined);
  }
}

export function spiceDbDatastoreAdminUrl(datastoreUrl: string): string {
  const url = new URL(datastoreUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function spiceDbDatastoreDatabaseName(datastoreUrl: string): string {
  const url = new URL(datastoreUrl);
  const name = url.pathname.replace(/^\//, "");
  if (name === "" || !IDENTIFIER.test(name)) {
    throw new Error("SpiceDB datastore URL is missing a database name");
  }
  return name;
}
