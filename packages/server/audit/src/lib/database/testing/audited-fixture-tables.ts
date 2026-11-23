import type { PostgresConnection } from "@dads-framework/postgres";

import { attachAuditTrigger } from "../attach-audit-trigger.js";

/**
 * Kit-owned tables for the audit suites, created in a test's private database
 * and put under audit the same way a real table's migration does it
 * (`attachAuditTrigger`). These fixtures are independent of any application schema.
 *
 * - `audit_fixture_parties` has a primary key, a unique slug, and an optional
 *   column, like a typical entity table.
 * - `audit_fixture_reports` has no primary key: it is named by a unique pair
 *   and partitioned by a uuid owner column, like the tables with a composite unique key.
 */
export const AUDITED_FIXTURE_TABLES = ["audit_fixture_parties", "audit_fixture_reports"] as const;

export async function createAuditedFixtureTables(pool: PostgresConnection["pool"]): Promise<void> {
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS audit_fixture_parties (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       name text NOT NULL,
       slug text NOT NULL UNIQUE,
       locale text
     )`,
    `CREATE TABLE IF NOT EXISTS audit_fixture_reports (
       device_id uuid NOT NULL,
       application text NOT NULL,
       partition_id uuid NOT NULL,
       note text,
       UNIQUE (device_id, application)
     )`,
  ];
  const builder = {
    sql: (statement: string) => {
      statements.push(statement);
    },
  };
  attachAuditTrigger(builder, "audit_fixture_parties", { keyColumns: ["id"] });
  attachAuditTrigger(builder, "audit_fixture_reports", {
    keyColumns: ["device_id", "application"],
    ownerColumn: "partition_id",
  });
  for (const statement of statements) {
    await pool.query(statement);
  }
}
