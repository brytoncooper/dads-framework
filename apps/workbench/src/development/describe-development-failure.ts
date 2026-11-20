import { WorkbenchDevelopmentError } from "./development-error.js";
import { WorkbenchInfrastructureError } from "./docker-infrastructure.js";

/** Keep intentional cancellation distinct from failed cleanup; diagnostics never expose causes. */
export function describeDevelopmentFailure(
  error: unknown,
  signal: AbortSignal,
) {
  const cancelled = signal.aborted && error === signal.reason;
  const message = cancelled
    ? "Workbench command cancelled."
    : error instanceof WorkbenchDevelopmentError ||
        error instanceof WorkbenchInfrastructureError
      ? error.message
      : error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? "Workbench port is already in use. Choose another --port; no existing process was stopped."
        : "Workbench startup or shutdown failed. Local data was retained; run workbench:stop before retrying.";
  return { message, exitCode: cancelled ? 130 : 1 };
}
