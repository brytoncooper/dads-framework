import { z } from "zod";

import type { Clock } from "@dads-framework/runtime/clock";
import {
  cronSchedule,
  defineJob,
  type JobDefinition,
  type JobLog,
} from "@dads-framework/job-queue";

import type { RequestLogWriter } from "../database/writers/request-log-writer.interface.js";

import {
  requirePositiveIntegerRetentionDays,
  retentionCutoff,
} from "./retention-window.js";

export const PRUNE_REQUEST_LOG_JOB = "audit.prune-request-log";

export type CreatePruneRequestLogJobDeps = {
  readonly writer: Pick<RequestLogWriter, "deleteRecordedBefore">;
  readonly clock: Pick<Clock, "now">;
  /** Days a `request_log` row survives before this sweep deletes it. */
  readonly retentionDays: number;
  readonly log: JobLog;
};

/**
 * Deletes every `request_log` row older than `retentionDays` (ADR-0112 slice
 * B). `request_log` is allowlisted out of the `audit_record` trigger — a
 * per-request environment record, not business history — so this delete
 * never produces an `audit_log` row. `audit_log` itself is never pruned.
 *
 * Runs under the job system actor (`job:audit.prune-request-log`), stamped by
 * the job queue driver before `run` is called — this job never touches actor
 * context itself.
 */
export function createPruneRequestLogJob(
  deps: CreatePruneRequestLogJobDeps,
): JobDefinition {
  requirePositiveIntegerRetentionDays(deps.retentionDays);
  return defineJob({
    name: PRUNE_REQUEST_LOG_JOB,
    payload: z.strictObject({}),
    retry: { attempts: 5, backoffMs: 1_000 },
    schedules: [
      cronSchedule({
        id: "audit.prune-request-log.daily",
        pattern: "0 0 3 * * *",
        timeZone: "UTC",
        payload: {},
      }),
    ],
    run: async () => {
      const cutoff = retentionCutoff(deps.clock.now(), deps.retentionDays);
      const deleted = await deps.writer.deleteRecordedBefore(cutoff);
      deps.log.info(
        { event: "request-log.pruned", deleted, cutoff },
        "request_log rows pruned",
      );
    },
  });
}
