import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { startTestPostgres, truncateAuditLog, type TestPostgres } from "@dads-framework/postgres/testing";

import { DrizzleAuditLogReader, createAuditLogExporter } from "../../index.js";

let postgres: TestPostgres | undefined;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await truncateAuditLog(postgres.pool);
}, 120_000);

afterAll(async () => {
  await postgres?.stop();
});

it("exports tenant metadata through exact timestamp pages and rechecks the grant", async () => {
  if (postgres === undefined) throw new Error("Expected Postgres fixture");
  await postgres.pool.query(`
    INSERT INTO audit_log (
      actor_kind, actor_id, request_id, table_name, row_key, row_after, operation,
      recorded_at, scope_values
    ) VALUES
      ('system', 'actor', 'oldest', 'documents', '{"id":"private-key"}',
        '{"secret":"private-image"}', 'insert', '2026-10-22T10:00:00.123455Z', '{"workspace":"mine"}'),
      ('system', 'actor', 'middle', 'documents', '{}', '{}', 'insert',
        '2026-10-22T10:00:00.123456Z', '{"workspace":"mine"}'),
      ('system', 'actor', 'elsewhere', 'documents', '{}', '{}', 'insert',
        '2026-10-22T10:00:00.123456Z', '{"workspace":"theirs"}'),
      ('system', 'actor', 'newest', 'documents', '{}', '{}', 'insert',
        '2026-10-22T10:00:00.123456Z', '{"workspace":"mine"}'),
      ('system', 'actor', 'unscoped', 'documents', '{}', '{}', 'insert',
        '2026-10-22T10:00:00.123456Z', '{}')
  `);

  let grant = true;
  const exportPage = createAuditLogExporter({
    reader: new DrizzleAuditLogReader(drizzle(postgres.pool)),
    tenantDimension: "workspace",
    authorize: (tenantId) => grant && tenantId === "mine",
  });

  const first = await exportPage({ tenantId: "mine", pageSize: 2 });
  if (first.kind !== "page" || first.nextCursor === null) {
    throw new Error("Expected a page with a continuation cursor");
  }
  expect(first.contentType).toBe("application/x-ndjson");
  expect(first.nextCursor.recordedAt).toBe("2026-10-22T10:00:00.123456Z");
  expect(
    first.body
      .trimEnd()
      .split("\n")
      .map((line) => z.json().parse(JSON.parse(line))),
  ).toEqual([expect.objectContaining({ requestId: "newest" }), expect.objectContaining({ requestId: "middle" })]);

  const continuation = {
    tenantId: "mine",
    pageSize: 2,
    olderThan: first.nextCursor,
  };
  const last = await exportPage(continuation);
  if (last.kind !== "page") throw new Error("Expected the final page");
  expect(last.nextCursor).toBeNull();
  expect(last.body).toMatch(/^\{[^\n]+\}\n$/u);
  const lastRecord = z.looseObject({ position: z.int().positive() }).parse(JSON.parse(last.body));
  expect(lastRecord).toEqual({
    position: lastRecord.position,
    recordedAt: "2026-10-22T10:00:00.123455Z",
    actorKind: "system",
    actorId: "actor",
    userId: null,
    requestId: "oldest",
    tableName: "documents",
    operation: "insert",
    changedColumns: null,
  });
  await expect(exportPage({ ...continuation, tenantId: "theirs" })).resolves.toEqual({ kind: "denied" });
  grant = false;
  await expect(exportPage(continuation)).resolves.toEqual({ kind: "denied" });
});
