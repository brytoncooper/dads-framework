import { z } from "zod";

import type { Clock } from "@dads-framework/core/runtime/clock";
import type { EmailDelivery } from "@dads-framework/email/delivery";
import {
  cronSchedule,
  defineJob,
  type JobDefinition,
  type JobLog,
} from "@dads-framework/job-queue";

import type { FaultAlertReader } from "../database/readers/fault-alert-reader.interface.js";
import { describeFaultLine } from "./logic/describe-fault-line.js";
import {
  isWorthSending,
  summarizeNewFaults,
} from "./logic/summarize-new-faults.js";
import { newFaultsEmailTemplate } from "./new-faults.email-template.js";

export const ALERT_NEW_FAULTS_JOB = "audit.alert-new-faults";

const MS_PER_HOUR = 60 * 60 * 1000;

export type CreateAlertNewFaultsJobDeps = {
  readonly reader: FaultAlertReader;
  readonly clock: Pick<Clock, "now">;
  readonly email: Pick<EmailDelivery, "enqueue" | "dispatch">;
  /** Who hears about it. Empty means nobody, and the job says so once. */
  readonly recipients: readonly string[];
  /**
   * How far back a sweep looks for faults that are happening.
   *
   * It bounds the scan, not the definition of new — `known_fault_fingerprints`
   * does that — so it can be raised to cover a missed run without reporting
   * anything twice. What it does decide is how long a fault has to stop
   * happening before a sweep stops noticing it.
   */
  readonly windowHours: number;
  readonly log: JobLog;
};

/**
 * Tells somebody when a fault type nobody has seen before starts happening.
 *
 * This is the job that makes all the recording matter. Everything else in the
 * telemetry work answers a question someone already thought to ask; this one
 * is the only part that speaks first.
 *
 * **New types, not volume.** A fingerprint nobody has been told about, that is
 * happening now, is the single highest-signal thing this data can say. A route
 * that fails a thousand times an hour and always has is a known problem, and
 * paging on it is how a channel becomes one people filter.
 *
 * **New means never reported, not recently absent.** The memory lives in
 * `known_fault_fingerprints`, which is never pruned, so a fault that goes
 * quiet for a month and returns is not news — and the sweep window can be any
 * length without a fingerprint being reported twice.
 *
 * **Silence when nothing is new.** No heartbeat email, deliberately: an hourly
 * "nothing broke" is indistinguishable from no alerting at all after about a
 * week, because nobody reads it.
 *
 * **Enqueued, not sent in-band.** The outbox owns delivery and retry, so a
 * mail vendor having a bad day cannot fail this job or lose the alert.
 */
export function createAlertNewFaultsJob(
  deps: CreateAlertNewFaultsJobDeps,
): JobDefinition {
  requirePositiveIntegerWindow(deps.windowHours);
  return defineJob({
    name: ALERT_NEW_FAULTS_JOB,
    payload: z.strictObject({}),
    retry: { attempts: 3, backoffMs: 5_000 },
    schedules: [
      cronSchedule({
        id: "audit.alert-new-faults.hourly",
        pattern: "0 5 * * * *",
        timeZone: "UTC",
        payload: {},
      }),
    ],
    run: async () => {
      if (deps.recipients.length === 0) {
        deps.log.info(
          { event: "fault-alerts.no-recipients" },
          "fault alerting has nobody to tell",
        );
        return;
      }

      const since = new Date(
        deps.clock.now().getTime() - deps.windowHours * MS_PER_HOUR,
      );
      await learnWhatIsAlreadyBroken(deps, since);

      const [server, client] = await Promise.all([
        deps.reader.unalertedServerFaultsSince(since),
        deps.reader.unalertedClientFaultsSince(since),
      ]);
      const summary = summarizeNewFaults({ server, client });
      if (!isWorthSending(summary)) return;

      const enqueued = await deps.email.enqueue(
        newFaultsEmailTemplate,
        {
          faults: summary.faults.map(describeFaultLine),
          totalOccurrences: summary.totalOccurrences,
          truncated: summary.truncated,
          windowHours: deps.windowHours,
        },
        { to: deps.recipients.map((address) => ({ address })) },
      );
      await deps.email.dispatch([enqueued.id]);
      // After the mail is durably queued, and only for the faults the mail
      // actually listed: a truncated tail stays unremembered so the next
      // sweep carries it rather than losing it.
      await deps.reader.rememberAlertedFaults(
        summary.faults.map((fault) => ({
          origin: fault.origin,
          fingerprint: fault.fingerprint,
        })),
      );
      deps.log.info(
        {
          event: "fault-alerts.sent",
          faults: summary.faults.length,
          occurrences: summary.totalOccurrences,
          truncated: summary.truncated,
        },
        "new faults alerted",
      );
    },
  });
}

/**
 * While the memory is empty, everything already on record is taken as known.
 *
 * Switching alerting on would otherwise report months of familiar problems in
 * one email, which is how a channel becomes one people filter on day one.
 * Only faults that predate the window are swallowed, so on a system where
 * nothing has broken yet this records nothing and the first fault to ever
 * happen still gets its alert.
 */
async function learnWhatIsAlreadyBroken(
  deps: CreateAlertNewFaultsJobDeps,
  since: Date,
): Promise<void> {
  if (await deps.reader.hasRememberedAnyFault()) return;
  const learned = await deps.reader.rememberFaultsSeenBefore(since);
  if (learned === 0) return;
  deps.log.info(
    { event: "fault-alerts.learned", faults: learned },
    "fault alerting took what was already broken as known",
  );
}

function requirePositiveIntegerWindow(windowHours: number): void {
  if (!Number.isInteger(windowHours) || windowHours <= 0) {
    throw new Error(
      `fault alert windowHours must be a positive integer, got ${windowHours}`,
    );
  }
}
