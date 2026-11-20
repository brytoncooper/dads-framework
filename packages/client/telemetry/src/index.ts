/**
 * Client fault reporting (`@dads-framework/client-telemetry`).
 *
 * The seam, its drivers, and the pure judgements that decide what is worth
 * reporting. Vendor-neutral: see ADR-0117 and
 * `docs/architecture/observability.md`.
 */
export {
  ClientTelemetry,
  NoneClientTelemetry,
  type TelemetryBreadcrumb,
  type TelemetryContext,
} from "@dads-framework/client-telemetry-core";
export {
  createClientTelemetry,
  type ClientTelemetryDriver,
  type CreateClientTelemetryOptions,
} from "./lib/create-client-telemetry.js";
export {
  LocalClientTelemetry,
  type LocalClientTelemetryOptions,
} from "./lib/local-client-telemetry.js";
export {
  SentryClientTelemetry,
  type LoadVendorReporter,
  type SentryClientTelemetryOptions,
  type VendorCaptureHint,
  type VendorErrorReporter,
} from "./lib/sentry-client-telemetry.js";
export { FanOutClientTelemetry } from "./lib/fan-out-client-telemetry.js";
export {
  sentryConfiguration,
  type SentryConfiguration,
  type SentryConfigurationInput,
  type SentryReplayMasking,
} from "./lib/logic/sentry-configuration.js";
export {
  describeClientError,
  type DescribedClientError,
} from "./lib/logic/describe-client-error.js";
export {
  installGlobalErrorReporting,
  type GlobalErrorReportingOptions,
} from "./lib/install-global-error-reporting.js";
export { isChunkLoadFailure } from "./lib/logic/is-chunk-load-failure.js";
export {
  shouldReportFailure,
  type FailureVerdict,
} from "./lib/logic/should-report-failure.js";
export { RefusedReadError, refusedReadOf } from "./lib/logic/refused-read.js";
