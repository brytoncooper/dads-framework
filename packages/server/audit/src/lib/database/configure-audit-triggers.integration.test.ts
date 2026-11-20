import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

import { configureAuditTriggers } from "./configure-audit-triggers.js";
import type { AuditLogScope } from "./readers/audit-log-reader.interface.js";
import { DrizzleAuditLogReader } from "./readers/drizzle-audit-log-reader.js";

describe("application audit configuration", () => {
  let postgres: TestPostgres;
  let reader: DrizzleAuditLogReader;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    reader = new DrizzleAuditLogReader(drizzle(postgres.pool));
    await postgres.pool.query(
      "CREATE TABLE scoped_documents (id text PRIMARY KEY, tenant_key text, group_key text)",
    );
    await postgres.pool.query(
      "CREATE TABLE temporary_tokens (id text PRIMARY KEY)",
    );
    const statements: string[] = [];
    configureAuditTriggers(
      {
        sql: (statement: string) => {
          statements.push(statement);
        },
      },
      {
        tables: {
          scoped_documents: {
            keyColumns: ["id"],
            scopeColumns: { workspace: "tenant_key", group: "group_key" },
          },
        },
        excludeTables: ["temporary_tokens"],
      },
    );
    for (const statement of statements) await postgres.pool.query(statement);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("captures a configured scope, excludes exempt tables, and denies missing scope", async () => {
    await postgres.pool.query(
      "INSERT INTO scoped_documents VALUES ('doc-a', 'space-a', 'group-1'), ('doc-b', 'space-b', NULL)",
    );
    await postgres.pool.query("INSERT INTO temporary_tokens VALUES ('token')");
    const applicationScope: AuditLogScope = {
      kind: "application",
      values: { workspace: "space-a", group: "group-1" },
    };
    const [row] = await reader.listRows(applicationScope, {}, null, 10);
    expect(row?.rowKey).toEqual({ id: "doc-a" });
    expect(row?.scopeValues).toEqual(applicationScope.values);
    expect(
      await reader.listRows({ kind: "application", values: {} }, {}, null, 10),
    ).toEqual([]);
    expect(
      await reader.listRows(
        { kind: "application", values: { workspace: "group-1" } },
        {},
        null,
        10,
      ),
    ).toEqual([]);
    expect(
      await reader.listRows(
        { kind: "platform" },
        { tableNames: ["temporary_tokens"] },
        null,
        10,
      ),
    ).toEqual([]);

    await postgres.pool.query(
      "UPDATE scoped_documents SET tenant_key = 'space-b' WHERE id = 'doc-a'",
    );
    const movedRows = await reader.listRows(
      { kind: "application", values: { workspace: "space-b" } },
      {},
      null,
      10,
    );
    expect(movedRows.map((entry) => entry.rowKey)).toEqual([{ id: "doc-b" }]);
  });
});
