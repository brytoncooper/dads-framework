/**
 * The driver that reports to our own API.
 *
 * "Own the data" in one class: faults go to `/api/client-diagnostics`, which
 * is same-origin with the app in every deployment, so there is no CORS
 * preflight, no third-party host, and nothing for an ad blocker to drop. What
 * the server does with the envelope afterwards — store it, forward it to a
 * vendor, both — is the server's decision, not the browser's.
 *
 * Three properties it has to hold, and how:
 *
 * - **A report never disturbs the page.** Every path is wrapped; a failure to
 *   report is dropped silently, because the alternative is an error handler
 *   that throws.
 * - **A burst costs one request.** Events buffer and flush together, so a
 *   component failing in a loop does not become a request storm on an API
 *   that may already be the thing that is unwell.
 * - **A crash still delivers.** The flush uses `keepalive`, so a report
 *   survives the navigation or unload that often follows a fatal client
 *   error. That is also why this driver uses `fetch` directly rather than the
 *   typed transport: `keepalive` is the whole point, and the transport does
 *   not expose it.
 */

import {
  CLIENT_DIAGNOSTIC_MAX_EVENTS,
  type ClientContext,
  type ClientDiagnosticEvent,
} from "@dads-framework/core/contract";

import { ClientTelemetry, type TelemetryBreadcrumb, type TelemetryContext } from "../core/index.js";
import { describeClientError } from "./logic/describe-client-error.js";

/** Breadcrumbs older than this say nothing about the fault that just happened. */
const MAX_BREADCRUMBS = 30;
/** Long enough to coalesce a burst, short enough to deliver before a reload. */
const FLUSH_DELAY_MS = 2_000;

export type LocalClientTelemetryOptions = {
  /** Where to report. Same-origin in every deployment. */
  readonly endpoint: string;
  /** The build that is running — the git SHA the SPA was stamped with. */
  readonly release: string;
  /** The environment snapshot, asked for per report so it stays current. */
  readonly clientContext: () => ClientContext | undefined;
  readonly now?: () => Date;
  /** Injected so a test can prove the request without a network. */
  readonly send?: typeof fetch;
};

export class LocalClientTelemetry extends ClientTelemetry {
  readonly #options: LocalClientTelemetryOptions;
  readonly #pending: ClientDiagnosticEvent[] = [];
  readonly #breadcrumbs: TelemetryBreadcrumb[] = [];
  #scheduled: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(options: LocalClientTelemetryOptions) {
    super();
    this.#options = options;
  }

  override reportError(error: unknown, context: TelemetryContext): void {
    try {
      this.#pending.push(this.#eventFor(error, context));
      if (this.#pending.length >= CLIENT_DIAGNOSTIC_MAX_EVENTS) {
        void this.flush(FLUSH_DELAY_MS);
        return;
      }
      this.#scheduleFlush();
    } catch {
      // A reporter that throws inside an error handler replaces a diagnosable
      // fault with an undiagnosable one.
    }
  }

  override addBreadcrumb(crumb: TelemetryBreadcrumb): void {
    try {
      this.#breadcrumbs.push(crumb);
      if (this.#breadcrumbs.length > MAX_BREADCRUMBS) this.#breadcrumbs.shift();
    } catch {
      // As above.
    }
  }

  override async flush(timeoutMs: number): Promise<boolean> {
    if (this.#scheduled !== undefined) {
      clearTimeout(this.#scheduled);
      this.#scheduled = undefined;
    }
    const events = this.#pending.splice(0, this.#pending.length);
    if (events.length === 0) return true;
    try {
      const send = this.#options.send ?? fetch;
      const response = await send(this.#options.endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        // Survives the unload that usually follows a fatal client error.
        keepalive: true,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      // Dropped on purpose. Re-buffering would grow without bound on a client
      // that is offline by design, and retrying a report is never worth
      // competing with the real requests the user is waiting on.
      return false;
    }
  }

  #scheduleFlush(): void {
    if (this.#scheduled !== undefined) return;
    this.#scheduled = setTimeout(() => {
      this.#scheduled = undefined;
      void this.flush(FLUSH_DELAY_MS);
    }, FLUSH_DELAY_MS);
  }

  #eventFor(error: unknown, context: TelemetryContext): ClientDiagnosticEvent {
    const described = describeClientError(error);
    const now = this.#options.now?.() ?? new Date();
    const clientContext = this.#options.clientContext();
    return {
      version: 1,
      occurredAt: now.toISOString(),
      fingerprint: described.fingerprint,
      kind: context.kind,
      severity: context.severity ?? "error",
      name: described.name,
      message: described.message,
      frames: [...described.frames],
      breadcrumbs: [...this.#breadcrumbs],
      release: this.#options.release,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(clientContext === undefined ? {} : { context: clientContext }),
    };
  }
}
