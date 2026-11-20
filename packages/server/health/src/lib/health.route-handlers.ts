import { ServiceUnavailableError } from "@dads-framework/http";

import type { HealthStatus, ReadyStatus } from "./health.schemas.js";

/** Dependency probes required before serving traffic. */
export type ReadinessChecks = {
  pingDatabase(): Promise<void>;
  pingCriticalServices(): Promise<void>;
};

/** Named handlers for the public liveness and readiness routes. */
export type HealthRouteHandlers = {
  readonly getHealth: () => HealthStatus;
  readonly getReady: () => Promise<ReadyStatus>;
};

/** Maps dependency probes to named route handlers. */
export function createHealthRouteHandlers(
  checks: ReadinessChecks,
): HealthRouteHandlers {
  function getHealth(): HealthStatus {
    return { status: "ok" };
  }

  async function getReady(): Promise<ReadyStatus> {
    try {
      await checks.pingDatabase();
      await checks.pingCriticalServices();
    } catch {
      throw new ServiceUnavailableError(
        "NOT_READY",
        "A critical dependency is unreachable",
      );
    }
    return { status: "ready" };
  }

  return { getHealth, getReady };
}
