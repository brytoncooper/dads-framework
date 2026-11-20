/**
 * The one place a reporter driver is chosen.
 *
 * Mirrors `createEmailSender`: a closed union, one branch each, and a loud
 * throw when a driver is asked for without what it needs. A misconfigured
 * reporter must not boot and silently drop every fault — that is precisely the
 * failure this whole initiative exists to end.
 *
 * `otlp` is deliberately absent from this union today. OpenTelemetry attaches
 * at the process level through its own standard environment variables, not
 * through a driver a caller picks, so adding it here would invent a second
 * way to configure the same thing.
 */

import { CombinedDiagnosticsReporter } from "./combined-diagnostics-reporter.js";
import type { DiagnosticsReporter } from "./diagnostics-reporter.js";
import {
  LogDiagnosticsReporter,
  type DiagnosticsLog,
} from "./log-diagnostics-reporter.js";
import type { SentryDestination } from "./logic/sentry-envelope.js";
import { NoneDiagnosticsReporter } from "./none-diagnostics-reporter.js";
import { SentryDiagnosticsReporter } from "./sentry-diagnostics-reporter.js";

/**
 * `sentry` writes the `log` line AND sends to Sentry — never instead of the
 * line, which is the copy that survives leaving a vendor.
 */
export type DiagnosticsDriver = "none" | "log" | "sentry";

export type CreateDiagnosticsReporterOptions = {
  readonly driver: DiagnosticsDriver;
  /** Required by `log` and `sentry`; the composition root's own logger. */
  readonly log?: DiagnosticsLog;
  /**
   * Required by `sentry`: where envelopes go, parsed from a DSN by the
   * composition root, plus what every event is stamped with.
   */
  readonly sentry?: {
    readonly destination: SentryDestination;
    readonly environment?: string;
    readonly release?: string;
    /** Injected so a test can prove the send without a network. */
    readonly send?: typeof fetch;
  };
};

export function createDiagnosticsReporter(
  options: CreateDiagnosticsReporterOptions,
): DiagnosticsReporter {
  if (options.driver === "none") return new NoneDiagnosticsReporter();
  if (options.log === undefined) {
    throw new Error(
      `DIAGNOSTICS_DRIVER=${options.driver} requires a logger — a reporter that cannot write is a reporter that silently drops every fault`,
    );
  }
  const logged = new LogDiagnosticsReporter(options.log);
  if (options.driver === "log") return logged;
  if (options.sentry === undefined) {
    throw new Error(
      "DIAGNOSTICS_DRIVER=sentry requires a Sentry destination — set DIAGNOSTICS_SENTRY_DSN",
    );
  }
  return new CombinedDiagnosticsReporter([
    logged,
    new SentryDiagnosticsReporter(options.sentry),
  ]);
}
