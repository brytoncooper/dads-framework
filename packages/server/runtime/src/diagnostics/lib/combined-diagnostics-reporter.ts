/**
 * Several reporters as one: each fault goes to every one of them.
 *
 * How `sentry` keeps the log line. Sentry is a rented copy; the line is the
 * ground truth a plant-local operator greps and the one that survives leaving
 * a vendor, so turning Sentry on must never turn the log off.
 */

import {
  DiagnosticsReporter,
  type FaultEvent,
} from "./diagnostics-reporter.js";

export class CombinedDiagnosticsReporter extends DiagnosticsReporter {
  constructor(private readonly reporters: readonly DiagnosticsReporter[]) {
    super();
  }

  override captureException(event: FaultEvent): void {
    for (const reporter of this.reporters) {
      try {
        reporter.captureException(event);
      } catch {
        // One reporter failing must not cost the others their copy.
      }
    }
  }

  /** True only when every reporter delivered within the deadline. */
  override async flush(timeoutMs: number): Promise<boolean> {
    const results = await Promise.all(
      this.reporters.map((reporter) =>
        reporter.flush(timeoutMs).catch(() => false),
      ),
    );
    return results.every(Boolean);
  }

  override async close(): Promise<void> {
    await Promise.allSettled(
      this.reporters.map((reporter) => reporter.close()),
    );
  }
}
