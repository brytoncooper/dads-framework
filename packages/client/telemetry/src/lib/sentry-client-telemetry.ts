/**
 * The rented half. Everything that knows the vendor's name lives here.
 *
 * It is one driver behind the same seam as `LocalClientTelemetry`, and it is
 * meant to run **beside** it rather than instead of it: our own API keeps the
 * unsampled ground truth, and this adds grouping, release health and the one
 * thing we cannot build — a recording of what the user was looking at. Leaving
 * the vendor is deleting this file and one union member.
 *
 * **Loaded lazily, on purpose.** The SDK and its replay recorder together are
 * the largest dependency the app would have, and most sessions never report
 * anything. So the import starts when the driver is constructed and reports
 * queue until it lands — which also means that with no DSN configured the
 * driver is never constructed and the chunk is never fetched. The integration
 * is **inert**, not merely disabled: nothing is downloaded, nothing runs, and
 * setting one environment variable is the whole of turning it on.
 *
 * **It cannot make the page worse.** Every path is wrapped, the queue is
 * bounded, and a failed load is permanent rather than retried: a browser that
 * could not fetch this chunk is usually a browser that is blocking it, and
 * retrying would be a request loop against an extension that will keep saying
 * no. The local driver is unaffected either way.
 */

import {
  ClientTelemetry,
  type TelemetryBreadcrumb,
  type TelemetryContext,
} from "@dads-framework/client-telemetry-core";
import {
  sentryConfiguration,
  type SentryConfiguration,
  type SentryConfigurationInput,
} from "./logic/sentry-configuration.js";

/** Where a fault happened, in terms the vendor indexes. */
export type VendorCaptureHint = {
  readonly tags: Readonly<Record<string, string>>;
  readonly level?: string;
};

/**
 * The slice of a vendor SDK this driver uses, once it is already started.
 *
 * Structural rather than imported, and deliberately does **not** include
 * `init`: starting the SDK is the loader's job, so the only code that has to
 * know a vendor's option names is the one adapter at the bottom of this file.
 * A second vendor speaking the same envelope protocol needs a loader and
 * nothing else.
 */
export type VendorErrorReporter = {
  captureException: (error: unknown, hint: VendorCaptureHint) => void;
  addBreadcrumb: (crumb: TelemetryBreadcrumb) => void;
  flush: (timeoutMs: number) => Promise<boolean>;
};

/** Starts the SDK with the configuration it must not be able to loosen. */
export type LoadVendorReporter = (
  configuration: SentryConfiguration,
) => Promise<VendorErrorReporter>;

export type SentryClientTelemetryOptions = SentryConfigurationInput & {
  /**
   * How the reporter arrives. Defaults to a dynamic import of
   * `@sentry/react`, so the vendor is a lazy chunk in the app and a stub in a
   * test.
   */
  readonly load?: LoadVendorReporter;
};

/**
 * Reports raised before the SDK lands are kept, not dropped — the faults
 * worth most are the early ones. Bounded because a page failing in a loop
 * while offline must not grow an array without end; past the cap the OLDEST
 * goes, since the first fault usually explains the rest.
 */
const MAX_QUEUED_REPORTS = 50;

type QueuedReport = {
  readonly error: unknown;
  readonly context: TelemetryContext;
};

export class SentryClientTelemetry extends ClientTelemetry {
  readonly #options: SentryClientTelemetryOptions;
  readonly #queued: QueuedReport[] = [];
  readonly #loading: Promise<void>;
  #reporter: VendorErrorReporter | undefined = undefined;
  #unavailable = false;

  constructor(options: SentryClientTelemetryOptions) {
    super();
    this.#options = options;
    this.#loading = this.#load();
  }

  override reportError(error: unknown, context: TelemetryContext): void {
    try {
      const reporter = this.#reporter;
      if (reporter === undefined) {
        this.#queue({ error, context });
        return;
      }
      reporter.captureException(error, hintFor(context));
    } catch {
      // A reporter that throws inside an error handler replaces a diagnosable
      // fault with an undiagnosable one.
    }
  }

  override addBreadcrumb(crumb: TelemetryBreadcrumb): void {
    try {
      // Not queued. A breadcrumb is only worth anything next to the fault it
      // preceded, and the local driver is keeping the same trail regardless.
      this.#reporter?.addBreadcrumb(crumb);
    } catch {
      // As above.
    }
  }

  override async flush(timeoutMs: number): Promise<boolean> {
    try {
      await this.#loading;
      const reporter = this.#reporter;
      if (reporter === undefined) return false;
      this.#drain(reporter);
      return await reporter.flush(timeoutMs);
    } catch {
      // A failed flush is information, not an error to handle.
      return false;
    }
  }

  /** Whether the vendor is actually running — for tests and for a status line. */
  get isReporting(): boolean {
    return this.#reporter !== undefined;
  }

  async #load(): Promise<void> {
    try {
      const load = this.#options.load ?? loadSentryReact;
      const reporter = await load(sentryConfiguration(this.#options));
      this.#reporter = reporter;
      this.#drain(reporter);
    } catch {
      // Permanent, and the queue goes with it: holding reports for a load
      // that will not happen is a leak, not a retry.
      this.#unavailable = true;
      this.#queued.splice(0, this.#queued.length);
    }
  }

  #queue(report: QueuedReport): void {
    if (this.#unavailable) return;
    this.#queued.push(report);
    if (this.#queued.length > MAX_QUEUED_REPORTS) this.#queued.shift();
  }

  #drain(reporter: VendorErrorReporter): void {
    const pending = this.#queued.splice(0, this.#queued.length);
    for (const report of pending) {
      try {
        reporter.captureException(report.error, hintFor(report.context));
      } catch {
        // One bad report must not strand the rest of the queue.
      }
    }
  }
}

function hintFor(context: TelemetryContext): VendorCaptureHint {
  return {
    tags: {
      kind: context.kind,
      ...(context.requestId === undefined
        ? {}
        : { request_id: context.requestId }),
    },
    ...(context.severity === undefined ? {} : { level: context.severity }),
  };
}

/**
 * The only function in the repository that names the package.
 *
 * The specifier is a literal so the bundler can see it, split it into its own
 * chunk, and serve it from our own origin rather than a CDN. Masking reaches
 * the recorder from `sentryConfiguration` and from nowhere else — there is no
 * argument here a caller could pass to loosen it.
 */
async function loadSentryReact(
  configuration: SentryConfiguration,
): Promise<VendorErrorReporter> {
  const sentry = await import("@sentry/react");
  const { replayMasking } = configuration;
  sentry.init({
    dsn: configuration.dsn,
    release: configuration.release,
    environment: configuration.environment,
    tunnel: configuration.tunnel,
    dataCollection: {
      userInfo: configuration.dataCollection.userInfo,
      cookies: configuration.dataCollection.cookies,
      httpHeaders: { ...configuration.dataCollection.httpHeaders },
      httpBodies: [...configuration.dataCollection.httpBodies],
      urlQueryParams: configuration.dataCollection.urlQueryParams,
    },
    replaysSessionSampleRate: configuration.replaysSessionSampleRate,
    replaysOnErrorSampleRate: configuration.replaysOnErrorSampleRate,
    tracesSampleRate: configuration.tracesSampleRate,
    integrations: [
      sentry.replayIntegration({
        maskAllText: replayMasking.maskAllText,
        maskAllInputs: replayMasking.maskAllInputs,
        blockAllMedia: replayMasking.blockAllMedia,
        networkDetailAllowUrls: [...replayMasking.networkDetailAllowUrls],
        networkCaptureBodies: replayMasking.networkCaptureBodies,
      }),
    ],
  });
  return {
    captureException: (error, hint) => {
      sentry.captureException(error, {
        tags: { ...hint.tags },
        ...(hint.level === undefined ? {} : { level: sentryLevel(hint.level) }),
      });
    },
    addBreadcrumb: (crumb) => {
      sentry.addBreadcrumb({ ...crumb });
    },
    flush: (timeoutMs) => sentry.flush(timeoutMs),
  };
}

/** Our severities are a subset of the vendor's; anything else is an error. */
function sentryLevel(severity: string): "warning" | "error" | "fatal" {
  if (severity === "warning") return "warning";
  if (severity === "fatal") return "fatal";
  return "error";
}
