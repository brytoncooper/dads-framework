import { Client } from "pg";

/** The operations used on an already connected Postgres session. */
export type PostgresClient = {
  readonly query: Client["query"];
  end(): Promise<void>;
};

export type {
  QueryConfig as PostgresQueryConfig,
  QueryResult as PostgresQueryResult,
  QueryResultRow as PostgresQueryResultRow,
} from "pg";

/**
 * A connected client outside any pool, for work that holds session state for
 * its whole run (an advisory lock, a migration journal, a schema rehearsal).
 * The caller ends it. Kept here so the postgres adapter is the one package
 * that opens the driver. The factory returns the native client because the
 * legacy migration runner needs to hand the same session to node-pg-migrate.
 */
export async function connectPostgresClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
