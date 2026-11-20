/**
 * Where captured request rows go.
 *
 * The http kit builds rows and knows nothing about storing them — the
 * Postgres sink lives in `@dads-framework/audit`, which owns the table. A class
 * rather than a bare function type because a sink has a lifecycle: it buffers,
 * it flushes, and shutdown has to drain it.
 *
 * `record` returns void on purpose. Capture runs in an `onResponse` hook,
 * after the client already has its answer; a sink that made the hook wait
 * would put a diagnostic write on the request path, which is the one thing
 * this design refuses to do.
 */

import type { RequestRecord } from "./request-record.js";

export abstract class RequestLogSink {
  /**
   * @param includeSuccessfulReads - whether a successful GET, HEAD or OPTIONS
   * is worth a row. Off by default: reads and CORS preflights are the
   * overwhelming majority of traffic and none of them changed anything, so the
   * table would be mostly noise.
   */
  constructor(readonly includeSuccessfulReads = false) {}

  /** Take one row. Never throws, never blocks the response. */
  abstract record(row: RequestRecord): void;

  /** Write everything buffered and wait for it. */
  abstract flush(): Promise<void>;

  /** Stop any timer, flush what is left, accept nothing further. */
  abstract close(): Promise<void>;
}
