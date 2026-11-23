/**
 * The `request_log` sink: buffers the rows the HTTP kit captures and writes
 * them in batches, off the request path.
 *
 * Three properties matter more than throughput here, because this is
 * diagnostic exhaust and the product does not depend on it:
 *
 * - **Bounded.** A database that stops answering cannot turn a request spike
 *   into an out-of-memory kill; past the ceiling the OLDEST row is dropped,
 *   because the newest rows are the ones describing the incident.
 * - **Silent.** A failed insert is logged and the rows are gone. Nothing here
 *   is allowed to reject into a caller, least of all into shutdown.
 * - **Drainable.** `close()` flushes, so a SIGTERM between two ticks does not
 *   lose the last second of traffic.
 */

import { withSystemActor } from "@dads-framework/core/audit-actor";
import { RequestLogSink, requestIdSchema, type RequestRecord } from "@dads-framework/http";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { requestLog } from "../database/generated-tables/request-log.tables.js";

/** What this sink says when a batch is lost, and when rows are dropped. */
export type RequestLogSinkLog = {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type PostgresRequestLogSinkOptions = {
  /** Ceiling on unwritten rows; past it the oldest is dropped. Default 2000. */
  readonly maxBufferedRows?: number;
  /** Buffered rows that trigger a flush without waiting for the timer. Default 200. */
  readonly flushAtRows?: number;
  /** How often the buffer is written regardless of size. Default 1000ms. */
  readonly flushIntervalMs?: number;
  /** Whether successful reads are captured at all (the hook asks the sink). */
  readonly includeSuccessfulReads?: boolean;
};

const DEFAULT_MAX_BUFFERED_ROWS = 2_000;
const DEFAULT_FLUSH_AT_ROWS = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

/**
 * Writes run under a named system actor. `request_log` is on
 * `AUDIT_TRIGGER_ALLOWLIST`, so no trigger demands one — but the attributed
 * pool stamps every checkout, and a deterministic stamp beats whatever actor
 * the async task that happened to trigger the flush was carrying.
 */
const REQUEST_LOG_ACTOR = "request-log";

export class PostgresRequestLogSink extends RequestLogSink {
  private readonly buffer: RequestRecord[] = [];
  private readonly maxBufferedRows: number;
  private readonly flushAtRows: number;
  private readonly flushIntervalMs: number;
  /** Serializes writes, so `flush()` awaits the insert already in flight. */
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** One warning per overflow episode, not one per dropped row. */
  private overflowing = false;

  constructor(
    private readonly db: DrizzleHandle,
    private readonly log: RequestLogSinkLog,
    options: PostgresRequestLogSinkOptions = {},
  ) {
    super(options.includeSuccessfulReads ?? false);
    this.maxBufferedRows = options.maxBufferedRows ?? DEFAULT_MAX_BUFFERED_ROWS;
    this.flushAtRows = options.flushAtRows ?? DEFAULT_FLUSH_AT_ROWS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.scheduleNextFlush();
  }

  override record(row: RequestRecord): void {
    if (this.closed) return;
    if (this.buffer.length >= this.maxBufferedRows) {
      this.buffer.shift();
      this.warnOnOverflow();
    }
    this.buffer.push(row);
    if (this.buffer.length >= this.flushAtRows) void this.flush();
  }

  override flush(): Promise<void> {
    this.writing = this.writing.then(
      () => this.writeBufferedRows(),
      () => this.writeBufferedRows(),
    );
    return this.writing;
  }

  override async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    await this.flush();
  }

  /** One insert per flush, and never a rejection — the rows are simply gone. */
  private async writeBufferedRows(): Promise<void> {
    const rows = this.buffer.splice(0, this.buffer.length);
    if (rows.length === 0) return;
    try {
      await withSystemActor(REQUEST_LOG_ACTOR, async () => {
        await this.db
          .insert(requestLog)
          .values(rows.map(toRequestLogInsert))
          // A retried request reuses its id, and the row already written is
          // the one that described what actually happened first.
          .onConflictDoNothing({ target: requestLog.requestId });
      });
      this.overflowing = false;
    } catch (error) {
      this.log.error(
        { event: "request-log.write-failed", err: error, rows: rows.length },
        "request log rows were dropped",
      );
    }
  }

  /**
   * A chained `setTimeout` rather than `setInterval`: an interval can stack
   * ticks on top of a slow write, and the only thing worse than losing
   * diagnostic rows is a diagnostic subsystem queueing work behind itself.
   * `unref()` so an idle process still exits — the flush loop must never be
   * the reason a container refuses to stop
   * (docs/architecture/http-edge.md#process-discipline--node-footguns).
   */
  private scheduleNextFlush(): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().then(() => {
        this.scheduleNextFlush();
      });
    }, this.flushIntervalMs);
    timer.unref();
    this.timer = timer;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private warnOnOverflow(): void {
    if (this.overflowing) return;
    this.overflowing = true;
    this.log.warn(
      { event: "request-log.buffer-overflow", limit: this.maxBufferedRows },
      "request log buffer is full — dropping the oldest rows",
    );
  }
}

/**
 * The record's fields are the table's columns, named one by one.
 * `requestId` is the one boundary crossing: the pipeline carries it as a
 * plain string end to end, and this insert is where it becomes the row's
 * branded primary key.
 */
function toRequestLogInsert(row: RequestRecord): typeof requestLog.$inferInsert {
  return {
    requestId: requestIdSchema.parse(row.requestId),
    recordedAt: row.recordedAt,
    method: row.method,
    routeId: row.routeId,
    path: row.path,
    status: row.status,
    durationMs: row.durationMs,
    actorKind: row.actorKind,
    actorId: row.actorId,
    authMethod: row.authMethod,
    accessKind: row.accessKind,
    permission: row.permission,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    decision: row.decision,
    errorCode: row.errorCode,
    ip: row.ip,
    forwardedFor: row.forwardedFor,
    userAgent: row.userAgent,
    clientHints: row.clientHints,
    acceptLanguage: row.acceptLanguage,
    clientContext: row.clientContext,
    apiRelease: row.apiRelease,
    dbQueryCount: row.dbQueryCount,
    dbMs: row.dbMs,
    authzCheckCount: row.authzCheckCount,
    authzMs: row.authzMs,
    authzCachedReadCount: row.authzCachedReadCount,
    authzFullyConsistentReadCount: row.authzFullyConsistentReadCount,
    authzLargestLookupCount: row.authzLargestLookupCount,
    instanceId: row.instanceId,
    traceId: row.traceId,
    exceptionType: row.exceptionType,
    exceptionFingerprint: row.exceptionFingerprint,
  };
}
