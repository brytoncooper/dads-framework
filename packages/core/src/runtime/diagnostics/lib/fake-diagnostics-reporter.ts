/**
 * The recording fake, for tests that assert what was captured.
 *
 * Exported only from the `/testing` subpath so production code cannot reach
 * it (docs/testing/seeders.md).
 */

import { DiagnosticsReporter, type FaultEvent } from "./diagnostics-reporter.js";

export class FakeDiagnosticsReporter extends DiagnosticsReporter {
  readonly captured: FaultEvent[] = [];
  readonly flushTimeouts: number[] = [];
  closed = false;

  override captureException(event: FaultEvent): void {
    this.captured.push(event);
  }
  override flush(timeoutMs: number): Promise<boolean> {
    this.flushTimeouts.push(timeoutMs);
    return Promise.resolve(true);
  }
  override close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
