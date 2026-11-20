/**
 * The recording fake, for tests that assert what was reported.
 *
 * Exported only from the `/testing` subpath so production code cannot reach
 * it (docs/testing/seeders.md).
 */

import {
  ClientTelemetry,
  type TelemetryBreadcrumb,
  type TelemetryContext,
} from "./client-telemetry.js";

export type ReportedFault = {
  readonly error: unknown;
  readonly context: TelemetryContext;
};

export class FakeClientTelemetry extends ClientTelemetry {
  readonly reported: ReportedFault[] = [];
  readonly breadcrumbs: TelemetryBreadcrumb[] = [];
  flushes = 0;

  override reportError(error: unknown, context: TelemetryContext): void {
    this.reported.push({ error, context });
  }
  override addBreadcrumb(crumb: TelemetryBreadcrumb): void {
    this.breadcrumbs.push(crumb);
  }
  override flush(): Promise<boolean> {
    this.flushes += 1;
    return Promise.resolve(true);
  }
}
