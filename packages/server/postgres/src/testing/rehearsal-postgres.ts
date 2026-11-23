import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash, randomUUID } from "node:crypto";
import { connectPostgresClient } from "../lib/connect-postgres-client.js";

/**
 * A Postgres cluster a migration rehearsal owns outright: it creates its own
 * databases (optionally from one of its own templates) and fingerprints the
 * cluster's roles and settings, which a shared test server cannot offer.
 */
export class RehearsalPostgres {
  private readonly databases = new Set<string>();
  constructor(readonly connectionString: string) {}

  static async start(): Promise<{
    postgres: RehearsalPostgres;
    stop: () => Promise<void>;
  }> {
    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    return {
      postgres: new RehearsalPostgres(container.getConnectionUri()),
      stop: async () => {
        await container.stop();
      },
    };
  }

  async createDatabase(template?: string): Promise<{ name: string; url: string }> {
    const name = `rehearsal_${randomUUID().replaceAll("-", "")}`;
    const admin = await connectPostgresClient(this.connectionString);
    try {
      if (template !== undefined && !this.databases.has(template))
        throw new Error("rehearsal template must belong to this isolated run");
      await admin.query(
        template === undefined ? `CREATE DATABASE "${name}"` : `CREATE DATABASE "${name}" TEMPLATE "${template}"`,
      );
      this.databases.add(name);
    } finally {
      await admin.end();
    }
    const url = new URL(this.connectionString);
    url.pathname = `/${name}`;
    return { name, url: url.toString() };
  }

  async clusterFingerprint(): Promise<string> {
    const client = await connectPostgresClient(this.connectionString);
    try {
      const hash = createHash("sha256");
      for (const relation of ["pg_authid", "pg_auth_members", "pg_db_role_setting"]) {
        const result = await client.query<{ row: string }>(
          `SELECT to_jsonb(state)::text AS row FROM pg_catalog.${relation} state ORDER BY to_jsonb(state)::text COLLATE "C"`,
        );
        hash.update(JSON.stringify(result.rows));
      }
      return hash.digest("hex");
    } finally {
      await client.end();
    }
  }
}
