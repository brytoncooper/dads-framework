import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  truncateAuditLog,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

import { makeAuditLog } from "../../../testing/audit-log.factory.js";
import { auditLog } from "../generated-tables/audit-log.tables.js";
import type {
  AuditLogRecord,
  AuditLogScope,
} from "./audit-log-reader.interface.js";
import { DrizzleAuditLogReader } from "./drizzle-audit-log-reader.js";

const WORKSPACE_A = "0192a3b4-0000-7000-8000-00000000000a";
const WORKSPACE_B = "0192a3b4-0000-7000-8000-00000000000b";
const GROUP_A1 = "0192a3b4-0000-7000-8000-0000000000a1";
const GROUP_A2 = "0192a3b4-0000-7000-8000-0000000000a2";

describe("DrizzleAuditLogReader keyset reads", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let reader: DrizzleAuditLogReader;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    reader = new DrizzleAuditLogReader(db);
    // Migrations that write data (a seeded built-in row, say) leave audit
    // rows behind; start every test from an empty log, not only the later ones.
    await truncateAuditLog(postgres.pool);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateAuditLog(postgres.pool);
  });

  /** Rows inserted as the trigger would write them, at chosen instants. */
  async function seed(
    rows: readonly Parameters<typeof makeAuditLog>[0][],
  ): Promise<void> {
    await db.insert(auditLog).values(rows.map((row) => makeAuditLog(row)));
  }

  const at = (iso: string) => new Date(iso);
  const requestsOf = (rows: readonly AuditLogRecord[]) =>
    rows.map((row) => row.requestId);

  it("lists newest first and resumes strictly after the cursor", async () => {
    await seed([
      { requestId: "oldest", recordedAt: at("2026-10-20T10:00:00Z") },
      { requestId: "middle", recordedAt: at("2026-10-21T10:00:00Z") },
      { requestId: "newest", recordedAt: at("2026-10-22T10:00:00Z") },
    ]);

    const first = await reader.listRows({ kind: "platform" }, {}, null, 2);
    const last = first.at(-1);
    if (last === undefined) throw new Error("expected a first page");
    const second = await reader.listRows(
      { kind: "platform" },
      {},
      last.cursor,
      2,
    );

    expect(requestsOf(first)).toEqual(["newest", "middle"]);
    expect(requestsOf(second)).toEqual(["oldest"]);
  });

  it("orders rows of one instant by position and pages through them without skipping", async () => {
    const sameInstant = at("2026-10-22T10:00:00.123456Z");
    await seed([
      { requestId: "first-written", recordedAt: sameInstant },
      { requestId: "second-written", recordedAt: sameInstant },
      { requestId: "third-written", recordedAt: sameInstant },
    ]);

    const seen: string[] = [];
    let cursor: AuditLogRecord["cursor"] | null = null;
    for (let page = 0; page < 4; page += 1) {
      const rows = await reader.listRows({ kind: "platform" }, {}, cursor, 1);
      const row = rows[0];
      if (row === undefined) break;
      seen.push(row.requestId);
      cursor = row.cursor;
    }

    expect(seen).toEqual(["third-written", "second-written", "first-written"]);
  });

  it("keeps the stored microseconds in the cursor", async () => {
    await seed([{ recordedAt: at("2026-10-22T10:00:00.123Z") }]);
    await postgres.pool.query(
      `INSERT INTO audit_log (actor_kind, actor_id, request_id, table_name, row_key, operation, recorded_at)
       VALUES ('system', 'test', 'micro', 'organizations', '{}'::jsonb, 'insert', '2026-10-22T10:00:00.123456Z')`,
    );

    const rows = await reader.listRows({ kind: "platform" }, {}, null, 1);

    expect(rows[0]?.cursor.recordedAt).toBe("2026-10-22T10:00:00.123456Z");
  });

  it("reads a workspace's rows only, optionally at one of its groups", async () => {
    await seed([
      { requestId: "a-company", scopeValues: { workspace: WORKSPACE_A } },
      {
        requestId: "a-plant-1",
        scopeValues: { workspace: WORKSPACE_A, group: GROUP_A1 },
      },
      {
        requestId: "a-plant-2",
        scopeValues: { workspace: WORKSPACE_A, group: GROUP_A2 },
      },
      { requestId: "b-company", scopeValues: { workspace: WORKSPACE_B } },
      { requestId: "no-scope" },
    ]);

    const company = await reader.listRows(
      { kind: "application", values: { workspace: WORKSPACE_A } },
      {},
      null,
      10,
    );
    const atPlant = await reader.listRows(
      {
        kind: "application",
        values: { workspace: WORKSPACE_A, group: GROUP_A1 },
      },
      {},
      null,
      10,
    );

    expect(requestsOf(company).sort()).toEqual([
      "a-company",
      "a-plant-1",
      "a-plant-2",
    ]);
    expect(requestsOf(atPlant)).toEqual(["a-plant-1"]);
  });

  it("reads a group's rows only", async () => {
    await seed([
      { requestId: "plant-1", scopeValues: { group: GROUP_A1 } },
      { requestId: "plant-2", scopeValues: { group: GROUP_A2 } },
      { requestId: "company", scopeValues: { workspace: WORKSPACE_A } },
    ]);

    const rows = await reader.listRows(
      { kind: "application", values: { group: GROUP_A1 } },
      {},
      null,
      10,
    );

    expect(requestsOf(rows)).toEqual(["plant-1"]);
  });

  it("reads every row on the platform, including rows with no scope, and narrows by workspace", async () => {
    await seed([
      { requestId: "a", scopeValues: { workspace: WORKSPACE_A } },
      { requestId: "b", scopeValues: { workspace: WORKSPACE_B } },
      { requestId: "none" },
    ]);

    const everything = await reader.listRows(
      { kind: "platform" },
      {},
      null,
      10,
    );
    const companyB = await reader.listRows(
      { kind: "application", values: { workspace: WORKSPACE_B } },
      {},
      null,
      10,
    );

    expect(requestsOf(everything).sort()).toEqual(["a", "b", "none"]);
    expect(requestsOf(companyB)).toEqual(["b"]);
  });

  it("bounds by from (inclusive) and to (exclusive)", async () => {
    await seed([
      { requestId: "before", recordedAt: at("2026-10-19T23:59:59Z") },
      { requestId: "at-from", recordedAt: at("2026-10-20T00:00:00Z") },
      { requestId: "inside", recordedAt: at("2026-10-21T12:00:00Z") },
      { requestId: "at-to", recordedAt: at("2026-10-22T00:00:00Z") },
    ]);

    const rows = await reader.listRows(
      { kind: "platform" },
      { from: at("2026-10-20T00:00:00Z"), to: at("2026-10-22T00:00:00Z") },
      null,
      10,
    );

    expect(requestsOf(rows)).toEqual(["inside", "at-from"]);
  });

  it("filters by the person behind the write and by actor kind", async () => {
    await seed([
      { requestId: "alice", userId: "alice", actorKind: "user" },
      {
        requestId: "alice-for-company",
        userId: "alice",
        actorKind: "company",
      },
      { requestId: "bob", userId: "bob", actorKind: "user" },
      { requestId: "device", actorKind: "device" },
    ]);

    const alice = await reader.listRows(
      { kind: "platform" },
      { userId: "alice" },
      null,
      10,
    );
    const devices = await reader.listRows(
      { kind: "platform" },
      { actorKinds: ["device"] },
      null,
      10,
    );

    expect(requestsOf(alice).sort()).toEqual(["alice", "alice-for-company"]);
    expect(requestsOf(devices)).toEqual(["device"]);
  });

  it("includes and excludes tables by name", async () => {
    await seed([
      { requestId: "orders", tableName: "orders" },
      { requestId: "lines", tableName: "order_lines" },
      { requestId: "flags", tableName: "feature_flags" },
    ]);

    const included = await reader.listRows(
      { kind: "platform" },
      { tableNames: ["orders", "order_lines"] },
      null,
      10,
    );
    const excluded = await reader.listRows(
      { kind: "platform" },
      { excludeTableNames: ["orders", "order_lines"] },
      null,
      10,
    );

    expect(requestsOf(included).sort()).toEqual(["lines", "orders"]);
    expect(requestsOf(excluded)).toEqual(["flags"]);
  });

  it("pages a workspace's and a group's shown tables, merged newest first, without skipping", async () => {
    const sameInstant = at("2026-10-22T10:00:00.123456Z");
    await seed(
      [
        {
          requestId: "order-old",
          tableName: "orders",
          recordedAt: at("2026-10-20T10:00:00Z"),
        },
        {
          requestId: "line-mid",
          tableName: "order_lines",
          recordedAt: at("2026-10-21T10:00:00Z"),
        },
        {
          requestId: "order-same-1",
          tableName: "orders",
          recordedAt: sameInstant,
        },
        {
          requestId: "line-same-2",
          tableName: "order_lines",
          recordedAt: sameInstant,
        },
        {
          requestId: "order-same-3",
          tableName: "orders",
          recordedAt: sameInstant,
        },
        {
          requestId: "flag-hidden",
          tableName: "feature_flags",
          recordedAt: at("2026-10-23T10:00:00Z"),
        },
      ].map((row) => ({
        ...row,
        scopeValues: { workspace: WORKSPACE_A, group: GROUP_A1 },
      })),
    );
    await seed([
      {
        requestId: "elsewhere",
        tableName: "orders",
        scopeValues: { workspace: WORKSPACE_B },
      },
    ]);
    const expected = [
      "order-same-3",
      "line-same-2",
      "order-same-1",
      "line-mid",
      "order-old",
    ];

    const scopes: readonly AuditLogScope[] = [
      { kind: "application", values: { workspace: WORKSPACE_A } },
      { kind: "application", values: { group: GROUP_A1 } },
    ];
    for (const scope of scopes) {
      const seen: string[] = [];
      let cursor: AuditLogRecord["cursor"] | null = null;
      for (let page = 0; page < 6; page += 1) {
        const rows = await reader.listRows(
          scope,
          { tableNames: ["orders", "order_lines"], excludeRequestId: "nobody" },
          cursor,
          2,
        );
        seen.push(...requestsOf(rows));
        const last = rows.at(-1);
        if (last === undefined) break;
        cursor = last.cursor;
      }
      expect(seen).toEqual(expected);
    }
  });

  it("reads the history of one record by table and key", async () => {
    await seed([
      { requestId: "mine", tableName: "orders", rowKey: { id: "order-1" } },
      { requestId: "other", tableName: "orders", rowKey: { id: "order-2" } },
      {
        requestId: "same-key-other-table",
        tableName: "order_lines",
        rowKey: { id: "order-1" },
      },
    ]);

    const rows = await reader.listRows(
      { kind: "platform" },
      { record: { tableName: "orders", rowKey: { id: "order-1" } } },
      null,
      10,
    );

    expect(requestsOf(rows)).toEqual(["mine"]);
  });

  it("reads every row of one request oldest first, and one row by position", async () => {
    await seed([
      { requestId: "shared", tableName: "orders" },
      { requestId: "shared", tableName: "order_lines" },
      { requestId: "elsewhere", tableName: "orders" },
    ]);

    const request = await reader.rowsForRequest("shared");
    const first = request[0];
    if (first === undefined) throw new Error("expected the request's rows");
    const single = await reader.rowAt(first.position);

    expect(request.map((row) => row.tableName)).toEqual([
      "orders",
      "order_lines",
    ]);
    expect(single?.requestId).toBe("shared");
    expect(single?.tableName).toBe("orders");
  });

  it("skips one request's rows, and counts the distinct records a request changed", async () => {
    await seed([
      { requestId: "bulk", tableName: "orders", rowKey: { id: "o1" } },
      { requestId: "bulk", tableName: "orders", rowKey: { id: "o1" } },
      { requestId: "bulk", tableName: "orders", rowKey: { id: "o2" } },
      { requestId: "bulk", tableName: "order_lines", rowKey: { id: "o1" } },
      {
        requestId: "bulk",
        tableName: "orders",
        rowKey: { id: "o9" },
        scopeValues: { workspace: WORKSPACE_A },
      },
      { requestId: "other", tableName: "orders" },
    ]);

    const rest = await reader.listRows(
      { kind: "platform" },
      { excludeRequestId: "bulk" },
      null,
      10,
    );

    expect(requestsOf(rest)).toEqual(["other"]);
    expect(
      await reader.countRecordsForRequest({ kind: "platform" }, "bulk", {}),
    ).toBe(4);
    expect(
      await reader.countRecordsForRequest(
        { kind: "application", values: { workspace: WORKSPACE_A } },
        "bulk",
        {},
      ),
    ).toBe(1);
    expect(
      await reader.countRecordsForRequest({ kind: "platform" }, "nobody", {}),
    ).toBe(0);
  });

  it("leaves out an update that changed none of its table's shown columns, and pages past it", async () => {
    await seed([
      {
        requestId: "created",
        tableName: "orders",
        operation: "insert",
        recordedAt: at("2026-10-22T10:00:00Z"),
      },
      {
        requestId: "status-moved",
        tableName: "orders",
        operation: "update",
        changedColumns: ["status", "updated_at"],
        recordedAt: at("2026-10-22T10:01:00Z"),
      },
      {
        requestId: "touched-only",
        tableName: "orders",
        operation: "update",
        changedColumns: ["updated_at"],
        recordedAt: at("2026-10-22T10:02:00Z"),
      },
      {
        requestId: "no-columns",
        tableName: "orders",
        operation: "update",
        changedColumns: null,
        recordedAt: at("2026-10-22T10:03:00Z"),
      },
      {
        requestId: "other-table",
        tableName: "sync_markers",
        operation: "update",
        changedColumns: ["updated_at"],
        recordedAt: at("2026-10-22T10:04:00Z"),
      },
      {
        requestId: "touched-again",
        tableName: "orders",
        operation: "update",
        changedColumns: ["updated_at"],
        recordedAt: at("2026-10-22T10:05:00Z"),
      },
    ]);
    const filter = { shownUpdateColumns: { orders: ["status", "name"] } };

    const all = await reader.listRows({ kind: "platform" }, filter, null, 10);
    const first = await reader.listRows({ kind: "platform" }, filter, null, 1);
    const firstRow = first.at(-1);
    if (firstRow === undefined) throw new Error("expected a first page");
    const second = await reader.listRows(
      { kind: "platform" },
      filter,
      firstRow.cursor,
      1,
    );

    expect(requestsOf(all)).toEqual(["other-table", "status-moved", "created"]);
    expect(requestsOf(first)).toEqual(["other-table"]);
    expect(requestsOf(second)).toEqual(["status-moved"]);
  });

  it("counts only the records a request changed that a page would list", async () => {
    await seed([
      {
        requestId: "bulk",
        tableName: "orders",
        rowKey: { id: "o1" },
        operation: "update",
        changedColumns: ["status"],
      },
      {
        requestId: "bulk",
        tableName: "orders",
        rowKey: { id: "o2" },
        operation: "update",
        changedColumns: ["updated_at"],
      },
      {
        requestId: "bulk",
        tableName: "orders",
        rowKey: { id: "o3" },
        operation: "insert",
      },
      {
        requestId: "bulk",
        tableName: "order_lines",
        rowKey: { id: "l1" },
        operation: "update",
        changedColumns: ["updated_at"],
      },
    ]);
    const filter = { shownUpdateColumns: { orders: ["status", "name"] } };

    const listed = await reader.listRows(
      { kind: "platform" },
      filter,
      null,
      10,
    );
    const counted = await reader.countRecordsForRequest(
      { kind: "platform" },
      "bulk",
      filter,
    );

    // o2 changed only updated_at, so neither the page nor the count has it.
    expect(counted).toBe(3);
    expect(counted).toBe(listed.length);
    expect(
      await reader.countRecordsForRequest({ kind: "platform" }, "bulk", {}),
    ).toBe(4);
  });

  it("answers null for a position no row holds", async () => {
    const [row] = await db
      .insert(auditLog)
      .values(makeAuditLog())
      .returning({ position: auditLog.position });
    if (row === undefined) throw new Error("expected a row");

    expect(await reader.rowAt(row.position)).not.toBeNull();
    await truncateAuditLog(postgres.pool);
    expect(await reader.rowAt(row.position)).toBeNull();
  });
});
