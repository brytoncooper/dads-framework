/**
 * WHAT: rows recorded by a remote instance land in the receiving database with the
 * caller's tag, a resend inserts nothing, and an empty batch is a no-op.
 *
 * WHY against a real database: idempotence is `ON CONFLICT DO NOTHING` on the
 * primary key and the new-row count comes from `RETURNING`; both are Postgres
 * behaviours a fake handle would only echo back.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { requestIdSchema } from "@dads-framework/http";
import {
  startTestPostgres,
  type TestPostgres,
  truncateRequestLog,
  truncateTables,
} from "@dads-framework/postgres/testing";

import { clientDiagnosticEventIdSchema } from "../client-diagnostics/client-diagnostic-event.ids.js";
import { clientDiagnosticEvents } from "../database/generated-tables/client-diagnostic-events.tables.js";
import { requestLog } from "../database/generated-tables/request-log.tables.js";
import { insertForeignClientFaults, insertForeignRequestRows } from "./insert-foreign-rows.js";

const REQUEST_ID = requestIdSchema.parse("site-request-1");

function requestRow(overrides: Partial<typeof requestLog.$inferInsert> = {}): typeof requestLog.$inferInsert {
  return {
    requestId: REQUEST_ID,
    recordedAt: new Date("2026-09-11T00:00:00.000Z"),
    method: "GET",
    routeId: "/api/things",
    path: "/api/things",
    status: 200,
    durationMs: 5,
    actorKind: "user",
    actorId: "user-1",
    authMethod: "session-cookie",
    accessKind: "permission",
    permission: "things_read",
    resourceType: "organizations/organization",
    resourceId: "org-1",
    decision: "allow",
    errorCode: null,
    ip: "203.0.113.10",
    forwardedFor: null,
    userAgent: "vitest",
    clientHints: null,
    acceptLanguage: null,
    clientContext: null,
    apiRelease: "remote:sha256:test",
    dbQueryCount: null,
    dbMs: null,
    authzCheckCount: null,
    authzMs: null,
    authzCachedReadCount: null,
    authzFullyConsistentReadCount: null,
    authzLargestLookupCount: null,
    instanceId: "remote:site-1",
    traceId: null,
    exceptionType: null,
    exceptionFingerprint: null,
    ...overrides,
  };
}

const FAULT_ID = "01926f3e-7b1a-7c3d-8e5f-0123456789ab";

function faultRow(
  overrides: Partial<typeof clientDiagnosticEvents.$inferInsert> = {},
): typeof clientDiagnosticEvents.$inferInsert {
  return {
    id: clientDiagnosticEventIdSchema.parse(FAULT_ID),
    recordedAt: new Date("2026-09-11T00:00:00.000Z"),
    occurredAt: new Date("2026-09-11T00:00:00.000Z"),
    fingerprint: "fingerprint-1",
    kind: "render",
    severity: "error",
    name: "TypeError",
    message: "boom",
    frames: [],
    breadcrumbs: [],
    release: "remote:test",
    client: "remote:site-1:web",
    requestId: null,
    actorKind: "user",
    actorId: "user-1",
    context: null,
    ...overrides,
  };
}

describe("insertForeignRequestRows / insertForeignClientFaults", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateRequestLog(postgres.pool);
    await truncateTables(postgres.pool, ["client_diagnostic_events"]);
  });

  it("stores a site request row with its source and import marker", async () => {
    const inserted = await insertForeignRequestRows(db, [requestRow()]);

    const stored = await db.select().from(requestLog).where(eq(requestLog.requestId, REQUEST_ID));
    expect(inserted).toBe(1);
    expect(stored.map((row) => row.instanceId)).toEqual(["remote:site-1"]);
    expect(stored.map((row) => row.imported)).toEqual([true]);
  });

  it("inserts nothing when the same rows are sent again", async () => {
    await insertForeignRequestRows(db, [requestRow()]);

    const resent = await insertForeignRequestRows(db, [requestRow()]);

    expect(resent).toBe(0);
    expect(await db.select().from(requestLog)).toHaveLength(1);
  });

  it("stores a client fault with its source tag", async () => {
    const row = faultRow();

    const inserted = await insertForeignClientFaults(db, [row]);

    const stored = await db.select().from(clientDiagnosticEvents).where(eq(clientDiagnosticEvents.id, row.id));
    expect(inserted).toBe(1);
    expect(stored.map((fault) => fault.client)).toEqual(["remote:site-1:web"]);
  });

  it("inserts nothing when a client fault is sent again", async () => {
    const row = faultRow();
    await insertForeignClientFaults(db, [row]);

    expect(await insertForeignClientFaults(db, [row])).toBe(0);
  });

  it("answers 0 for an empty array", async () => {
    expect(await insertForeignRequestRows(db, [])).toBe(0);
    expect(await insertForeignClientFaults(db, [])).toBe(0);
  });
});
