import { systemActor, type AuditActor } from "@dads-framework/core/audit-actor";

/**
 * Who a job run writes as.
 *
 * Background work has no human and no request behind it, but the audit trigger
 * still refuses an unattributed write — so a run is attributed to the job. The
 * name is spelled here rather than in each driver so the in-process and BullMQ
 * paths cannot record the same job under two different ids.
 *
 * Each call mints a fresh request id: one run's rows belong together, and the
 * drivers log that id with `job.started` so they can be found.
 */
export function jobRunActor(jobName: string): AuditActor {
  return systemActor(`job:${jobName}`);
}
