import { describeJobs, type JobDefinition } from "../job-definition.js";
import type {
  JobQueue,
  JobQueueCounts,
  JobQueueInspection,
} from "../job-queue.js";
import { JobRegistry } from "../job-registry.js";

/** One accepted piece of work, exactly as the caller enqueued it. */
export type EnqueuedJob = {
  readonly jobName: string;
  readonly payload: unknown;
};

/**
 * Inspectable stand-in for tests: records every enqueue in `enqueued` so a
 * test can assert what the system would have scheduled, without Redis, a
 * timer, or a real worker.
 *
 * Enqueueing runs NOTHING. `runEnqueued()` is the separate step that drains
 * what is waiting through the registered handlers, so a test decides when the
 * work happens and can assert the state on either side of it. Name validation
 * is the real `JobRegistry`, so an unregistered name fails here exactly as it
 * would in production.
 *
 * A handler that throws is counted and collected in `failures` rather than
 * escaping the drain — the same trade {@link InProcessJobQueue} makes, because
 * a queue whose drain rejects on the first bad job cannot be used to prove what
 * happened to the rest.
 */
export class FakeJobQueue implements JobQueue {
  private readonly registry = new JobRegistry();
  /** Every enqueue, in order, whether or not it has been drained yet. */
  readonly enqueued: EnqueuedJob[] = [];
  /** Every error a drained handler threw, in drain order. */
  readonly failures: Error[] = [];
  private drained = 0;
  private completed = 0;
  private started = false;

  constructor(private readonly queueName = "dads-api") {}

  register(jobs: readonly JobDefinition[]): void {
    if (this.started) {
      throw new Error("Jobs must be registered before the job queue starts");
    }
    this.registry.register(jobs);
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  enqueue(jobName: string, payload: unknown): Promise<void> {
    this.registry.get(jobName);
    this.enqueued.push({ jobName, payload });
    return Promise.resolve();
  }

  inspect(): Promise<JobQueueInspection> {
    return Promise.resolve({
      driver: "in-process",
      queueName: this.queueName,
      jobs: describeJobs(this.registry.list()),
      schedules: [],
      counts: this.counts(),
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Run everything enqueued since the last drain, in enqueue order. */
  async runEnqueued(): Promise<void> {
    while (this.drained < this.enqueued.length) {
      const job = this.enqueued[this.drained];
      this.drained += 1;
      if (job === undefined) continue;
      await this.runOne(job);
    }
  }

  private async runOne(job: EnqueuedJob): Promise<void> {
    try {
      await this.registry.get(job.jobName).run(job.payload);
      this.completed += 1;
    } catch (error) {
      this.failures.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private counts(): JobQueueCounts {
    return {
      waiting: this.enqueued.length - this.drained,
      active: 0,
      delayed: 0,
      completed: this.completed,
      failed: this.failures.length,
    };
  }
}
