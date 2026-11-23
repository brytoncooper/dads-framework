import { z } from "zod";

import { defineJob, type JobDefinition } from "@dads-framework/job-queue/core";

import { outboundEmailIdSchema } from "../outbound-email-status.js";
import { EMAIL_DELIVER_JOB } from "./email-job-names.js";

type DeliverOutboundEmailOperation = {
  execute(input: { readonly outboundEmailId: ReturnType<typeof outboundEmailIdSchema.parse> }): Promise<unknown>;
};

/**
 * The queued door to one delivery. `attempts: 1` is deliberate and
 * load-bearing: the outbound-email row is the retry engine
 * (INV-EMAILDELIVERY-3), so letting the queue retry as well would give the
 * in-process and BullMQ drivers different behavior and double-count attempts.
 */
export function createDeliverOutboundEmailJob(operation: DeliverOutboundEmailOperation): JobDefinition {
  return defineJob({
    name: EMAIL_DELIVER_JOB,
    payload: z.strictObject({ outboundEmailId: outboundEmailIdSchema }),
    retry: { attempts: 1, backoffMs: 1 },
    schedules: [],
    run: async (payload) => {
      await operation.execute({ outboundEmailId: payload.outboundEmailId });
    },
  });
}
