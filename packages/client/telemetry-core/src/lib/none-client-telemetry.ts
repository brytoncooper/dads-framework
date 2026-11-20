/**
 * The driver that reports nowhere.
 *
 * The default, and the posture for plant-local and offline deployments where
 * there is no endpoint to report to and no operator waiting on one. It is a
 * real implementation rather than an optional dependency so that every call
 * site can report unconditionally — a `telemetry?.reportError(...)` scattered
 * through error handlers is how half of them end up missing.
 */

import { ClientTelemetry } from "./client-telemetry.js";

export class NoneClientTelemetry extends ClientTelemetry {
  override reportError(): void {
    return undefined;
  }
  override addBreadcrumb(): void {
    return undefined;
  }
  override flush(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
