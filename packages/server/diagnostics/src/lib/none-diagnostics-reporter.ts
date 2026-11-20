/**
 * The reporter that sends nowhere.
 *
 * The default, and the posture for plant-local deployments: no aggregator to
 * reach and no operator watching one, so the pino line beside the capture is
 * the ground truth and this adds nothing to it. A real implementation rather
 * than an optional dependency, so every chokepoint can capture
 * unconditionally — an `if (reporter)` scattered through error handlers is how
 * half of them end up missing one.
 */

import { DiagnosticsReporter } from "./diagnostics-reporter.js";

export class NoneDiagnosticsReporter extends DiagnosticsReporter {
  override captureException(): void {
    return undefined;
  }
  override flush(): Promise<boolean> {
    return Promise.resolve(true);
  }
  override close(): Promise<void> {
    return Promise.resolve();
  }
}
