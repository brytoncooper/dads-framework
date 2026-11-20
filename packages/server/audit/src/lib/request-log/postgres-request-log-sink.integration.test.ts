/**
 * WHAT: the batched sink — rows reach `request_log`, a retried request id is
 * ignored rather than fatal, the buffer is bounded, the timer flushes on its
 * own, and `close()` drains what is left.
 *
 * WHY against a real database: three of those five are Postgres behaviours
 * this code leans on and does not implement — that one multi-row insert
 * carries every column type (`inet`, two `jsonb`s, a `timestamptz`), that
 * `ON CONFLICT DO NOTHING` on the primary key swallows a duplicate INSIDE a
 * batch as well as across batches, and that an insert into `request_log`
 * raises nothing despite the `audit_record` trigger sitting on every other
 * table. A fake handle would agree with whatever this file assumed.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RequestRecord } from "@dads-framework/http";
import {
  startTestPostgres,
  type TestPostgres,
  truncateRequestLog,
} from "@dads-framework/postgres/testing";

import { requestLog } from "../database/generated-tables/request-log.tables.js";
import { PostgresRequestLogSink } from "./postgres-request-log-sink.js";

type WarnedEvent = { readonly event?: unknown };

class RecordingLog {
  readonly warnings: WarnedEvent[] = [];
  readonly errors: WarnedEvent[] = [];

  warn(entry: object): void {
    this.warnings.push(entry);
  }

  error(entry: object): void {
    this.errors.push(entry);
  }
}

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: "request-1",
    recordedAt: new Date("2026-09-11T00:00:00.000Z"),
    method: "POST",
    routeId: "/api/orgs/:id/orders",
    path: "/api/orgs/:id/orders",
    status: 201,
    durationMs: 7,
    actorKind: "user",
    actorId: "user-1",
    authMethod: "session-cookie",
    accessKind: "permission",
    permission: "orders_create",
    resourceType: "organizations/organization",
    resourceId: "org-1",
    decision: "allow",
    errorCode: null,
    ip: "203.0.113.10",
    forwardedFor: "203.0.113.10, 198.51.100.1",
    userAgent: "vitest",
    clientHints: { "sec-ch-ua-platform": '"macOS"' },
    acceptLanguage: "en-US",
    clientContext: {
      version: 1,
      client: "web",
      build: "2026.09.11",
      timeZone: "America/Chicago",
      locale: "en-US",
    },
    apiRelease: "sha256:test",
    dbQueryCount: null,
    dbMs: null,
    authzCheckCount: null,
    authzMs: null,
    authzCachedReadCount: null,
    authzFullyConsistentReadCount: null,
    authzLargestLookupCount: null,
    instanceId: null,
    traceId: null,
    exceptionType: null,
    exceptionFingerprint: null,
    ...overrides,
  };
}

describe("PostgresRequestLogSink", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  const sinks: PostgresRequestLogSink[] = [];

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await Promise.all(sinks.splice(0).map((sink) => sink.close()));
    await truncateRequestLog(postgres.pool);
  });

  function sinkWith(
    options: ConstructorParameters<typeof PostgresRequestLogSink>[2] = {},
  ): { sink: PostgresRequestLogSink; log: RecordingLog } {
    const log = new RecordingLog();
    const sink = new PostgresRequestLogSink(db, log, options);
    sinks.push(sink);
    return { sink, log };
  }

  async function storedRequestIds(): Promise<string[]> {
    const rows = await db.select().from(requestLog);
    return rows.map((row) => row.requestId).sort();
  }

  it("writes every buffered row on flush, with each column intact", async () => {
    const { sink } = sinkWith();

    sink.record(record({ requestId: "r-1" }));
    sink.record(record({ requestId: "r-2" }));
    sink.record(record({ requestId: "r-3" }));
    await sink.flush();

    expect(await storedRequestIds()).toEqual(["r-1", "r-2", "r-3"]);
    const [stored] = await db.select().from(requestLog);
    expect(stored).toMatchObject({
      requestId: "r-1",
      method: "POST",
      path: "/api/orgs/:id/orders",
      status: 201,
      decision: "allow",
      actorKind: "user",
      ip: "203.0.113.10",
      clientHints: { "sec-ch-ua-platform": '"macOS"' },
      apiRelease: "sha256:test",
    });
  });

  it("stores what the request cost, and null when nothing measured it", async () => {
    // The columns ADR-0117 added: a row carries the counters through the sink
    // unchanged, and a request served before the counters existed keeps nulls
    // — which reads as "not measured" rather than as "did no work".
    const { sink } = sinkWith();

    sink.record(
      record({
        requestId: "measured",
        dbQueryCount: 41,
        dbMs: 86,
        authzCheckCount: 40,
        authzMs: 513,
        authzCachedReadCount: 38,
        authzFullyConsistentReadCount: 2,
        authzLargestLookupCount: 1_204,
        instanceId: "ip-10-0-1-23",
      }),
    );
    sink.record(record({ requestId: "unmeasured" }));
    await sink.flush();

    const stored = await db.select().from(requestLog);
    expect(stored).toEqual([
      expect.objectContaining({
        requestId: "measured",
        dbQueryCount: 41,
        dbMs: 86,
        authzCheckCount: 40,
        authzMs: 513,
        authzCachedReadCount: 38,
        authzFullyConsistentReadCount: 2,
        authzLargestLookupCount: 1_204,
        instanceId: "ip-10-0-1-23",
      }),
      expect.objectContaining({
        requestId: "unmeasured",
        dbQueryCount: null,
        dbMs: null,
        authzCheckCount: null,
        authzMs: null,
        authzCachedReadCount: null,
        authzFullyConsistentReadCount: null,
        authzLargestLookupCount: null,
        instanceId: null,
      }),
    ]);
  });

  it("ignores a request id it already stored — a retry reuses its id", async () => {
    const { sink, log } = sinkWith();

    sink.record(record({ requestId: "r-1", status: 201 }));
    await sink.flush();
    sink.record(record({ requestId: "r-1", status: 500 }));
    await sink.flush();

    expect(await storedRequestIds()).toEqual(["r-1"]);
    const [stored] = await db.select().from(requestLog);
    expect(stored?.status).toBe(201);
    expect(log.errors).toHaveLength(0);
  });

  it("drops the oldest row when the buffer is full, warning once per episode", async () => {
    const { sink, log } = sinkWith({ maxBufferedRows: 2, flushAtRows: 100 });

    sink.record(record({ requestId: "r-1" }));
    sink.record(record({ requestId: "r-2" }));
    sink.record(record({ requestId: "r-3" }));
    sink.record(record({ requestId: "r-4" }));
    await sink.flush();

    expect(await storedRequestIds()).toEqual(["r-3", "r-4"]);
    expect(log.warnings).toHaveLength(1);
  });

  it("flushes on its own once the batch size is reached", async () => {
    const { sink } = sinkWith({ flushAtRows: 2, flushIntervalMs: 60_000 });

    sink.record(record({ requestId: "r-1" }));
    sink.record(record({ requestId: "r-2" }));
    await sink.flush();

    expect(await storedRequestIds()).toEqual(["r-1", "r-2"]);
  });

  it("flushes on its timer without anyone asking", async () => {
    const { sink } = sinkWith({ flushAtRows: 1000, flushIntervalMs: 25 });

    sink.record(record({ requestId: "r-1" }));
    await waitUntil(async () => (await storedRequestIds()).length === 1);

    expect(await storedRequestIds()).toEqual(["r-1"]);
  });

  it("drains the buffer on close and accepts nothing afterwards", async () => {
    const { sink } = sinkWith({ flushAtRows: 1000, flushIntervalMs: 60_000 });

    sink.record(record({ requestId: "r-1" }));
    await sink.close();
    sink.record(record({ requestId: "r-2" }));
    await sink.flush();

    expect(await storedRequestIds()).toEqual(["r-1"]);
  });
});

/** Poll rather than sleep a fixed span — the timer tick is not a promise we hold. */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition was never met");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
