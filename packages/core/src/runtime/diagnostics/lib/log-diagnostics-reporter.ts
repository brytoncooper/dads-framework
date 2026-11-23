/**
 * The reporter that writes one structured line per fault.
 *
 * The default everywhere that has no aggregator, and the ground truth
 * everywhere that does. It is deliberately more than a fallback: the line it
 * writes carries the fingerprint, so `grep` and a log query can group faults
 * the same way an aggregator would — and a plant-local operator at 2am gets
 * the same answer as someone with a dashboard, just with fewer clicks
 * available.
 *
 * `event: "fault.captured"` rather than reusing `unhandled.exception`: the
 * error handler still logs its own line with the full `err` serialization, and
 * two lines with the same discriminant would double every count built on it.
 * This one is the grouped, queryable twin.
 */

import { DiagnosticsReporter, severityOf, type FaultEvent } from "./diagnostics-reporter.js";
import { describeException } from "./logic/describe-exception.js";

/** The narrow logger this needs; the kit never holds a whole pino instance. */
export type DiagnosticsLog = {
  error(entry: object, message: string): void;
};

export class LogDiagnosticsReporter extends DiagnosticsReporter {
  constructor(private readonly log: DiagnosticsLog) {
    super();
  }

  override captureException(event: FaultEvent): void {
    try {
      const described = describeException(event.error);
      this.log.error(
        {
          event: "fault.captured",
          source: event.source,
          severity: severityOf(event),
          type: described.type,
          fingerprint: event.fingerprint ?? described.fingerprint,
          message: described.message,
          stack: described.stack,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          ...(event.routeId === undefined ? {} : { routeId: event.routeId }),
          ...(event.jobName === undefined ? {} : { jobName: event.jobName }),
          ...(event.actor === undefined ? {} : { actorKind: event.actor.kind, actorId: event.actor.id }),
          ...(event.release === undefined ? {} : { release: event.release }),
          ...(event.instanceId === undefined ? {} : { instanceId: event.instanceId }),
        },
        "fault captured",
      );
    } catch {
      // A reporter that threw inside an error handler would replace a
      // diagnosable fault with an undiagnosable one.
    }
  }

  /** Nothing is buffered, so there is nothing to wait for. */
  override flush(): Promise<boolean> {
    return Promise.resolve(true);
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }
}
