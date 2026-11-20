/** A scoped read stays bounded even when most history belongs to other tables or scopes. */
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  truncateAuditLog,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

import { makeAuditLog } from "../../../testing/audit-log.factory.js";
import { auditLog } from "../generated-tables/audit-log.tables.js";
import type {
  AuditLogRowFilter,
  AuditLogScope,
} from "./audit-log-reader.interface.js";
import { DrizzleAuditLogReader } from "./drizzle-audit-log-reader.js";

const WORKSPACE = "0192a3b4-0000-7000-8000-00000000000a";
const GROUP = "0192a3b4-0000-7000-8000-0000000000a1";
const NOISE_ROWS = 20_000;
const OTHER_WORKSPACES_ROWS = 60_000;
/** Far below the noise: a plan that reads past the noise fails this. */
const MOST_ROWS_A_READ_MAY_PASS = 500;

const SHOWN_TABLES = ["projects", "notes", "orders"];

type SentQuery = { readonly sql: string; readonly params: unknown[] };

describe("DrizzleAuditLogReader under noise the page never shows", () => {
  let postgres: TestPostgres;
  let sent: SentQuery[];
  let reader: DrizzleAuditLogReader;
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * 3_600_000);

  beforeAll(async () => {
    postgres = await startTestPostgres();
    sent = [];
    const db = drizzle(postgres.pool, {
      logger: { logQuery: (sql, params) => sent.push({ sql, params }) },
    });
    reader = new DrizzleAuditLogReader(db);
    await truncateAuditLog(postgres.pool);

    // The shown history: a handful of real changes, days old.
    await db.insert(auditLog).values(
      // Two, three and four days old, one row per shown table.
      SHOWN_TABLES.map((tableName, index) =>
        makeAuditLog({
          requestId: `shown-${String(index)}`,
          tableName,
          scopeValues: { workspace: WORKSPACE, group: GROUP },
          recordedAt: ago(48 + index * 24),
        }),
      ),
    );
    // The noise: newer than every shown row, so a newest-first walk of the
    // scope's time index meets all of it before the first shown row.
    await postgres.pool.query(
      `INSERT INTO audit_log
         (actor_kind, actor_id, request_id, table_name, row_key, operation,
          changed_columns, scope_values, recorded_at)
       SELECT 'device', 'edge-device', 'noise-' || n, 'heartbeat',
              '{}'::jsonb, 'update', ARRAY['updated_at'], jsonb_build_object('workspace', $1::text, 'group', $2::text),
              now() - make_interval(secs => n * 2)
         FROM generate_series(1, $3::int) AS n`,
      [WORKSPACE, GROUP, NOISE_ROWS],
    );
    // Every other company's ordinary history, in the very tables the page
    // shows: what makes a seek on the table name alone no better a path.
    await postgres.pool.query(
      `INSERT INTO audit_log
         (actor_kind, actor_id, request_id, table_name, row_key, operation,
          scope_values, recorded_at)
       SELECT 'user', 'someone', 'elsewhere-' || n, ($2::text[])[1 + n % 3],
              '{}'::jsonb, 'insert', jsonb_build_object('workspace', gen_random_uuid()::text),
              now() - make_interval(secs => n * 3)
         FROM generate_series(1, $1::int) AS n`,
      [OTHER_WORKSPACES_ROWS, SHOWN_TABLES],
    );
    await postgres.pool.query("ANALYZE audit_log");
  }, 180_000);

  afterAll(async () => {
    await truncateAuditLog(postgres.pool);
    await postgres.stop();
  });

  const customerFilter: AuditLogRowFilter = {
    from: ago(24 * 7),
    tableNames: SHOWN_TABLES,
    actorKinds: ["user", "workspace", "staff", "device", "system"],
  };

  it.each<[string, AuditLogScope, string]>([
    [
      "workspace",
      { kind: "application", values: { workspace: WORKSPACE } },
      "audit_log_scope_table_idx",
    ],
    [
      "group",
      { kind: "application", values: { group: GROUP } },
      "audit_log_scope_table_idx",
    ],
  ])(
    "reads the %s page's shown rows without reading past the noise",
    async (_page, scope, seekIndex) => {
      sent.length = 0;
      const rows = await reader.listRows(scope, customerFilter, null, 50);

      expect(rows.map((row) => row.requestId)).toEqual([
        "shown-0",
        "shown-1",
        "shown-2",
      ]);
      const read = sent.at(-1);
      if (read === undefined) throw new Error("the reader sent no query");
      const plan = await explain(read);
      expect(rowsReadPast(plan)).toBeLessThan(MOST_ROWS_A_READ_MAY_PASS);
      expect(plan).toContain(`"Index Name":"${seekIndex}"`);
    },
  );

  async function explain(query: SentQuery): Promise<string> {
    const result = await postgres.pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`,
      query.params,
    );
    return JSON.stringify(result.rows);
  }
});

/** Every row a plan node fetched and then threw away. */
function rowsReadPast(plan: string): number {
  return [...plan.matchAll(/"Rows Removed by Filter":(\d+)/g)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
}
