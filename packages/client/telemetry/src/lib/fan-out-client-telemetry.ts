/**
 * "Own the data, rent the tooling" as one class.
 *
 * A fault goes to every destination, not to the best one. Our own API is
 * always first and always present, so the ground truth exists whether or not
 * a vendor is configured, whether or not the user's browser will load it, and
 * whether or not we are still paying for it next year. The vendor is an
 * addition to that record, never a replacement for it.
 *
 * The isolation is the point: one destination throwing, hanging, or being
 * blocked by an extension must not cost the others a single report. So every
 * call is wrapped per destination, and `flush` waits on all of them rather
 * than stopping at the first that fails.
 */

import {
  ClientTelemetry,
  type TelemetryBreadcrumb,
  type TelemetryContext,
} from "@dads-framework/client-telemetry-core";

export class FanOutClientTelemetry extends ClientTelemetry {
  readonly #destinations: readonly ClientTelemetry[];

  constructor(destinations: readonly ClientTelemetry[]) {
    super();
    this.#destinations = destinations;
  }

  override reportError(error: unknown, context: TelemetryContext): void {
    for (const destination of this.#destinations) {
      try {
        destination.reportError(error, context);
      } catch {
        // Drivers already swallow their own faults; this is the wall for one
        // that does not, so a new destination cannot silence the old ones.
      }
    }
  }

  override addBreadcrumb(crumb: TelemetryBreadcrumb): void {
    for (const destination of this.#destinations) {
      try {
        destination.addBreadcrumb(crumb);
      } catch {
        // As above.
      }
    }
  }

  /** True only when every destination delivered; a partial flush is a failure. */
  override async flush(timeoutMs: number): Promise<boolean> {
    const results = await Promise.all(
      this.#destinations.map(async (destination) => {
        try {
          return await destination.flush(timeoutMs);
        } catch {
          return false;
        }
      }),
    );
    return results.every((delivered) => delivered);
  }
}
