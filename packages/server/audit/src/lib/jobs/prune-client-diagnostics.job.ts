import { z } from "zod";

import type { Clock } from "@dads-framework/runtime/clock";
import {
  cronSchedule,
  defineJob,
  type JobDefinition,
  type JobLog,
} from "@dads-framework/job-queue";

import type { ClientDiagnosticWriter } from "../database/writers/client-diagnostic-writer.interface.js";

import {
  requirePositiveIntegerRetentionDays,
  retentionCutoff,
} from "./retention-window.js";

export const PRUNE_CLIENT_DIAGNOSTICS_JOB = "audit.prune-client-diagnostics";

export type CreatePruneClientDiagnosticsJobDeps = {
  readonly writer: Pick<ClientDiagnosticWriter, "deleteRecordedBefore">;
  readonly clock: Pick<Clock, "now">;
  /** Days a reported fault survives before this sweep deletes it. */
  readonly retentionDays: number;
  readonly log: JobLog;
};

/**
 * Deletes every `client_diagnostic_events` row older than `retentionDays`.
 *
 * Its own clock, shorter than `request_log`'s by default, because an
 * exception message is the one free-text column in either table and a page
 * can compose one from whatever a user typed. A fault stops being worth
 * keeping once the release that produced it is gone; an address stays useful
 * for longer. Two questions, two windows.
 *
 * Runs an hour after the request-log sweep so the two never contend for the
 * same connections, and under the job system actor like every other job.
 */
export function createPruneClientDiagnosticsJob(
  deps: CreatePruneClientDiagnosticsJobDeps,
): JobDefinition {
  requirePositiveIntegerRetentionDays(deps.retentionDays);
  return defineJob({
    name: PRUNE_CLIENT_DIAGNOSTICS_JOB,
    payload: z.strictObject({}),
    retry: { attempts: 5, backoffMs: 1_000 },
    schedules: [
      cronSchedule({
        id: "audit.prune-client-diagnostics.daily",
        pattern: "0 0 4 * * *",
        timeZone: "UTC",
        payload: {},
      }),
    ],
    run: async () => {
      const cutoff = retentionCutoff(deps.clock.now(), deps.retentionDays);
      const deleted = await deps.writer.deleteRecordedBefore(cutoff);
      deps.log.info(
        { event: "client-diagnostics.pruned", deleted, cutoff },
        "client_diagnostic_events rows pruned",
      );
    },
  });
}
