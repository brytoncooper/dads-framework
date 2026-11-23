/**
 * The reporter that sends a fault to Sentry, without Sentry's SDK.
 *
 * One envelope per fault, posted straight to the project's ingest. No SDK
 * means no global hooks, no monkey-patched `http`, no breadcrumbs collected
 * from places nobody reviewed: what leaves is exactly what
 * `buildSentryEnvelope` builds, and nothing else.
 *
 * Sends are fire-and-forget with a short timeout, and every one is tracked so
 * `flush` can wait for them — the fatal handler's bounded flush is the one
 * time a send has to outrun an exit. A Sentry outage costs the copy in Sentry
 * and nothing else: the log line written beside this is the ground truth.
 */

import { randomUUID } from "node:crypto";

import { DiagnosticsReporter, type FaultEvent } from "./diagnostics-reporter.js";
import {
  buildSentryEnvelope,
  sentryAuthHeader,
  sentryEnvelopeUrl,
  type SentryDestination,
} from "./logic/sentry-envelope.js";

/** How long one send may take before it is abandoned. */
const SEND_TIMEOUT_MS = 5_000;
/** A fault storm drops sends past this rather than holding unbounded memory. */
const MAX_IN_FLIGHT = 100;

export type SentryDiagnosticsReporterOptions = {
  readonly destination: SentryDestination;
  /** `application environment`; Sentry's `environment`. */
  readonly environment?: string;
  /** `application release`; used when the fault does not carry one. */
  readonly release?: string;
  /** Injected so a test can prove the send without a network. */
  readonly send?: typeof fetch;
  readonly now?: () => Date;
  readonly sendTimeoutMs?: number;
};

export class SentryDiagnosticsReporter extends DiagnosticsReporter {
  readonly #inFlight = new Set<Promise<void>>();
  readonly #url: string;
  readonly #auth: string;

  constructor(private readonly options: SentryDiagnosticsReporterOptions) {
    super();
    this.#url = sentryEnvelopeUrl(options.destination);
    this.#auth = sentryAuthHeader(options.destination);
  }

  override captureException(event: FaultEvent): void {
    try {
      if (this.#inFlight.size >= MAX_IN_FLIGHT) return;
      const body = buildSentryEnvelope(event, {
        eventId: randomUUID().replaceAll("-", ""),
        now: (this.options.now ?? (() => new Date()))(),
        ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
        ...(this.options.release === undefined ? {} : { release: this.options.release }),
      });
      this.#track(this.#post(body));
    } catch {
      // Capturing runs inside an error handler; it must never become a fault.
    }
  }

  /** Waits for every send in flight, or for `timeoutMs`, whichever is first. */
  override flush(timeoutMs: number): Promise<boolean> {
    if (this.#inFlight.size === 0) return Promise.resolve(true);
    const settled = Promise.allSettled([...this.#inFlight]).then(() => true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      // The deadline itself must never hold a dying process open.
      timer.unref();
      void settled.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  override async close(): Promise<void> {
    await this.flush(this.options.sendTimeoutMs ?? SEND_TIMEOUT_MS);
  }

  async #post(body: string): Promise<void> {
    try {
      const send = this.options.send ?? fetch;
      await send(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": this.#auth,
        },
        body,
        signal: AbortSignal.timeout(this.options.sendTimeoutMs ?? SEND_TIMEOUT_MS),
      });
    } catch {
      // An unreachable vendor is an expected state, not a fault of ours.
    }
  }

  #track(send: Promise<void>): void {
    this.#inFlight.add(send);
    void send.finally(() => this.#inFlight.delete(send));
  }
}
