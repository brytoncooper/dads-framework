import type { ConnectionOptions, Queue, Worker } from "bullmq";

import { runWithAuditActor } from "@dads-framework/audit-actor";
import type { DiagnosticsReporter } from "@dads-framework/runtime/diagnostics";

import { bullMqJobOptions } from "./bullmq-job-options.js";
import { jobRunActor } from "./job-actor.js";
import {
  describeJobs,
  type JobDefinition,
  type JobLog,
  type JobQueue,
  type JobQueueInspection,
  type RunningJobSchedule,
} from "../core/index.js";
import { JobRegistry } from "../core/provider.js";
import {
  attemptsOf,
  isTerminalAttempt,
  type JobAttempts,
} from "./logic/job-attempts.js";
import { redisConnection } from "./redis-connection.js";

/** BullMQ adapter: Redis owns durable work, retries, and recurring schedules. */
export class BullMqJobQueue implements JobQueue {
  private readonly registry = new JobRegistry();
  private driver: Promise<{ queue: Queue; Worker: typeof Worker }> | undefined;
  private readonly connection: ConnectionOptions;
  private worker: Worker | undefined;
  private started = false;
  // The lifecycle is serialized: a `close()` that overlaps a `start()` waits
  // for that start to settle, and each worker is torn down exactly once no
  // matter which path gets there first. Otherwise a shutdown lands in the
  // middle of the worker's Redis handshake — the `Connection is closed.`
  // window described on `waitUntilReady` below.
  /** The in-flight `start()`, while one is running. */
  private starting: Promise<void> | undefined;
  /**
   * The one `worker.close()` per worker; every other caller awaits that same
   * promise. Keyed by the worker because a `start()` that fails leaves
   * `started` false, so a retry builds a replacement worker — shared state
   * here would report that replacement as already closed and leave it holding
   * its Redis connections.
   */
  private readonly closingWorkers = new WeakMap<Worker, Promise<void>>();
  /**
   * The in-flight or finished `close()`; a second `close()` awaits it. Sticky
   * on purpose: `close()` closes the queue too, and the driver has no
   * restart-after-close lifecycle (see docs/reference/job-queue.md).
   */
  private closing: Promise<void> | undefined;

  /**
   * One failed attempt, logged — and reported only if it was the last one.
   *
   * `willRetry` is the difference between "this job is having a bad minute"
   * and "this work is lost". A line that does not say which makes every
   * failure look equally alarming, and the ones that matter become
   * indistinguishable from the ones that do not. For the same reason only the
   * final attempt is captured: reporting every retry would make one flaky job
   * look like a hundred bugs.
   */
  private reportFailedJob(
    jobName: string | undefined,
    jobId: string | undefined,
    attempts: JobAttempts,
    error: unknown,
  ): void {
    this.log.error(
      {
        event: "job.failed",
        jobName: jobName ?? "unknown",
        jobId,
        attemptsMade: attempts.made,
        attempts: attempts.allowed,
        willRetry: !isTerminalAttempt(attempts),
        err: error,
      },
      "job failed",
    );
    if (!isTerminalAttempt(attempts)) return;
    this.diagnostics?.captureException({
      error,
      source: "job",
      ...(jobName === undefined ? {} : { jobName }),
    });
  }

  constructor(
    redisUrl: string,
    private readonly log: JobLog,
    private readonly queueName: string,
    private readonly concurrency = 5,
    /**
     * Where a permanently failed job goes besides the log line.
     * Optional: a queue built without one behaves exactly as it does today.
     */
    private readonly diagnostics?: DiagnosticsReporter,
  ) {
    if (queueName.trim().length === 0) {
      throw new Error("BullMQ queue name must not be empty");
    }
    this.connection = redisConnection(redisUrl);
  }

  private getDriver(): Promise<{ queue: Queue; Worker: typeof Worker }> {
    if (this.closing) {
      return Promise.reject(new Error("Job queue is closed"));
    }
    this.driver ??= import("bullmq").then(({ Queue, Worker }) => {
      const queue = new Queue(this.queueName, { connection: this.connection });
      queue.on("error", (error) => {
        this.log.error(
          { event: "job.queue.error", err: error },
          "job queue error",
        );
      });
      return { queue, Worker };
    });
    return this.driver;
  }

  register(jobs: readonly JobDefinition[]): void {
    if (this.started) {
      throw new Error("Jobs must be registered before the job queue starts");
    }
    this.registry.register(jobs);
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Job queue has already been started");
    }
    this.started = true;
    // Published before the first await, so a `close()` arriving in the very
    // next tick already has something to wait on.
    this.starting = this.startConsuming();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startConsuming(): Promise<void> {
    try {
      const { queue, Worker } = await this.getDriver();
      await this.reconcileSchedules(queue);
      this.worker = new Worker(
        this.queueName,
        async (job) => {
          const definition = this.registry.get(job.name);
          // Attributed to the job, with a per-run request id — see jobRunActor
          // and ADR-0112. Logged so one run's audit rows can be found.
          const actor = jobRunActor(job.name);
          this.log.info(
            {
              event: "job.started",
              jobName: job.name,
              jobId: job.id,
              requestId: actor.requestId,
            },
            "job started",
          );
          await runWithAuditActor(actor, () => definition.run(job.data));
        },
        { connection: this.connection, concurrency: this.concurrency },
      );
      this.worker.on("completed", (job) => {
        this.log.info(
          { event: "job.completed", jobName: job.name, jobId: job.id },
          "job completed",
        );
      });
      this.worker.on("failed", (job, error) => {
        this.reportFailedJob(job?.name, job?.id, attemptsOf(job), error);
      });
      this.worker.on("error", (error) => {
        this.log.error(
          { event: "job.worker.error", err: error },
          "job worker error",
        );
      });
      // Started means consuming. BullMQ opens the worker's two connections in
      // its constructor and finishes them asynchronously, and closing one that
      // is still initializing makes BullMQ drop its own listeners and then emit
      // `error` on the listener-less connection — an unhandled
      // `Error: Connection is closed.` nobody can catch. Resolving only once
      // both connections are ready keeps `close()` out of that window.
      await this.worker.waitUntilReady();
    } catch (error) {
      this.started = false;
      // `started = false` claims nothing is running, so nothing may be left
      // holding a Redis connection.
      const abandoned = this.worker;
      this.worker = undefined;
      if (abandoned) {
        await this.closeWorkerOnce(abandoned);
      }
      throw error;
    }
  }

  async enqueue(jobName: string, payload: unknown): Promise<void> {
    const definition = this.registry.get(jobName);
    const { queue } = await this.getDriver();
    await queue.add(jobName, payload, bullMqJobOptions(definition));
  }

  async inspect(): Promise<JobQueueInspection> {
    const { queue } = await this.getDriver();
    const [schedulers, counts] = await Promise.all([
      queue.getJobSchedulers(0, -1, true),
      queue.getJobCounts("waiting", "active", "delayed", "completed", "failed"),
    ]);
    return {
      driver: "bullmq",
      queueName: this.queueName,
      jobs: describeJobs(this.registry.list()),
      schedules: schedulers.map(describeBullMqSchedule),
      counts: {
        waiting: counts["waiting"] ?? 0,
        active: counts["active"] ?? 0,
        delayed: counts["delayed"] ?? 0,
        completed: counts["completed"] ?? 0,
        failed: counts["failed"] ?? 0,
      },
    };
  }

  async close(): Promise<void> {
    this.closing ??= this.closeOnce();
    await this.closing;
  }

  private async closeOnce(): Promise<void> {
    const starting = this.starting;
    if (starting) {
      // Wait out the readiness handshake before touching the worker. Only the
      // ordering is taken from it — the failure itself is still delivered to
      // `start()`'s own caller, which is the one that asked for it.
      await starting.catch(() => undefined);
    }
    const running = this.worker;
    this.worker = undefined;
    if (running) {
      await this.closeWorkerOnce(running);
    }
    const driver = await this.driver?.catch(() => undefined);
    await driver?.queue.close();
  }

  /**
   * Whichever arrives first — `start()`'s failure path or `close()` — performs
   * the single `worker.close()` for that worker; the other awaits that same
   * promise. A worker the driver has abandoned never answers for the one that
   * replaced it.
   */
  private closeWorkerOnce(worker: Worker): Promise<void> {
    const alreadyClosing = this.closingWorkers.get(worker);
    if (alreadyClosing) {
      return alreadyClosing;
    }
    const closingWorker = worker.close();
    this.closingWorkers.set(worker, closingWorker);
    return closingWorker;
  }

  private async reconcileSchedules(queue: Queue): Promise<void> {
    const expectedScheduleIds = new Set(
      this.registry
        .list()
        .flatMap((definition) =>
          definition.schedules.map((schedule) => schedule.id),
        ),
    );
    const existingSchedules = await queue.getJobSchedulers(0, -1, true);
    for (const schedule of existingSchedules) {
      if (!expectedScheduleIds.has(schedule.key)) {
        await queue.removeJobScheduler(schedule.key);
        this.log.info(
          {
            event: "job.schedule.removed",
            jobName: schedule.name,
            scheduleId: schedule.key,
          },
          "stale job schedule removed",
        );
      }
    }

    for (const definition of this.registry.list()) {
      for (const schedule of definition.schedules) {
        const repeat =
          schedule.kind === "cron"
            ? { pattern: schedule.pattern, tz: schedule.timeZone }
            : { every: schedule.everyMs };
        await queue.upsertJobScheduler(schedule.id, repeat, {
          name: definition.name,
          data: schedule.payload,
          opts: bullMqJobOptions(definition),
        });
        this.log.info(
          {
            event: "job.schedule.registered",
            jobName: definition.name,
            scheduleId: schedule.id,
          },
          "job schedule registered",
        );
      }
    }
  }
}

type BullMqSchedule = Awaited<ReturnType<Queue["getJobSchedulers"]>>[number];

function describeBullMqSchedule(scheduler: BullMqSchedule): RunningJobSchedule {
  if (scheduler.pattern) {
    return {
      id: scheduler.key,
      jobName: scheduler.name,
      kind: "cron",
      pattern: scheduler.pattern,
      ...(scheduler.tz === undefined ? {} : { timeZone: scheduler.tz }),
      nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
    };
  }
  return {
    id: scheduler.key,
    jobName: scheduler.name,
    kind: "interval",
    ...(scheduler.every === undefined ? {} : { everyMs: scheduler.every }),
    nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
  };
}
