import { z } from "zod";

import { cronSchedule, defineJob, type JobDefinition } from "@dads-framework/job-queue/core";

import { EMAIL_SWEEP_JOB } from "./email-job-names.js";

/** The schedule id operators see; one arm, upserted by the worker process. */
export const EMAIL_SWEEP_SCHEDULE_ID = "email.sweep.every-minute";

type SweepOutboundEmailsOperation = {
  execute(): Promise<unknown>;
};

/**
 * Every minute, on the minute, in UTC. A minute is the outbox's whole latency
 * budget for anything the immediate dispatch missed — a scheduled send coming
 * due, a row whose retry has arrived, a claim nobody came back for.
 *
 * `attempts: 1` for the same reason the delivery job has it: a sweep that
 * fails is picked up by the next minute's sweep, and a queue-level retry
 * would only stack them.
 */
export function createSweepOutboundEmailsJob(operation: SweepOutboundEmailsOperation): JobDefinition {
  return defineJob({
    name: EMAIL_SWEEP_JOB,
    payload: z.strictObject({}),
    retry: { attempts: 1, backoffMs: 1 },
    schedules: [
      cronSchedule({
        id: EMAIL_SWEEP_SCHEDULE_ID,
        pattern: "0 * * * * *",
        timeZone: "UTC",
        payload: {},
      }),
    ],
    run: async () => {
      await operation.execute();
    },
  });
}
