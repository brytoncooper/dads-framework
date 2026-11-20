import type { JobsOptions, KeepJobs } from "bullmq";
import type { JobDefinition } from "../core/index.js";

const COMPLETED_RETENTION: KeepJobs = { age: 86_400, count: 1_000 };
const FAILED_RETENTION: KeepJobs = { age: 604_800, count: 5_000 };

/** Map execution policy to bounded BullMQ storage and retry options. */
export function bullMqJobOptions(definition: JobDefinition): JobsOptions {
  return {
    attempts: definition.retry.attempts,
    backoff: { type: "exponential", delay: definition.retry.backoffMs },
    removeOnComplete: COMPLETED_RETENTION,
    removeOnFail: FAILED_RETENTION,
  };
}
