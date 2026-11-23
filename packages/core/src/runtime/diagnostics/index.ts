/**
 * Server fault capture (`@dads-framework/core/runtime/diagnostics`).
 *
 * One seam, drivers behind it, and the pure description that decides how
 * faults group. See ADR-0117 and `docs/architecture/observability.md`.
 */
export {
  DiagnosticsReporter,
  type FaultEvent,
  type FaultSeverity,
  type FaultSource,
} from "./lib/diagnostics-reporter.js";
export type { SentryDestination } from "./lib/logic/sentry-envelope.js";
export {
  createDiagnosticsReporter,
  type CreateDiagnosticsReporterOptions,
  type DiagnosticsDriver,
} from "./lib/create-diagnostics-reporter.js";
export {
  LogDiagnosticsReporter,
  type DiagnosticsLog,
} from "./lib/log-diagnostics-reporter.js";
export { NoneDiagnosticsReporter } from "./lib/none-diagnostics-reporter.js";
export {
  describeException,
  type DescribedException,
} from "./lib/logic/describe-exception.js";
