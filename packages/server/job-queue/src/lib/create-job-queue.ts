import type { DiagnosticsReporter } from "@dads-framework/core/runtime/diagnostics";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { InProcessJobQueue } from "./in-process-job-queue.js";
import type { JobLog, JobQueue } from "../core/index.js";

export type CreateJobQueueOptions = {
  /** Stable application namespace; different applications use different queues. */
  readonly queueName: string;
  /** "in-process" (tests, container-free dev) or "bullmq" (compose, prod). */
  readonly driver: "in-process" | "bullmq";
  /** required when driver is "bullmq" */
  readonly redisUrl?: string;
  /** Explicit worker bound (process-discipline bar). */
  readonly concurrency?: number;
  /**
   * Where a permanently failed job goes besides its log line.
   * Only the LAST attempt is reported; a retry is not a fault yet.
   */
  readonly diagnostics?: DiagnosticsReporter;
};

/**
 * Pick the in-process or BullMQ driver from JOBS_DRIVER. The driver is an
 * env decision, never a code one.
 */
export function createJobQueue(options: CreateJobQueueOptions, log: JobLog): JobQueue {
  if (options.queueName.trim().length === 0) {
    throw new Error("Job queue name must not be empty");
  }
  if (options.driver === "bullmq") {
    if (!options.redisUrl) {
      throw new Error("JOBS_DRIVER=bullmq requires REDIS_URL");
    }
    return new BullMqJobQueue(options.redisUrl, log, options.queueName, options.concurrency ?? 5, options.diagnostics);
  }
  return new InProcessJobQueue(log, options.queueName);
}
