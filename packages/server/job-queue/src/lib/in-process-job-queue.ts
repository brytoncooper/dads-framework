import cronParser from "cron-parser";

import { runWithAuditActor } from "@dads-framework/core/audit-actor";

import { jobRunActor } from "./job-actor.js";
import {
  describeJobs,
  type JobDefinition,
  type JobSchedule,
  type JobLog,
  type JobQueue,
  type JobQueueCounts,
  type JobQueueInspection,
  type RunningJobSchedule,
} from "../core/index.js";
import { JobRegistry } from "../core/provider.js";

type ScheduledTimer = {
  readonly jobName: string;
  readonly schedule: JobSchedule<unknown>;
  timer: ReturnType<typeof setTimeout> | undefined;
  nextRunAt: string | null;
};

/**
 * Container-free driver for tests and local development. It schedules recurring work
 * in memory without persistence or retries.
 */
export class InProcessJobQueue implements JobQueue {
  private readonly registry = new JobRegistry();
  private readonly timers = new Map<string, ScheduledTimer>();
  private readonly activeRuns = new Set<Promise<void>>();
  private counts: JobQueueCounts = emptyCounts();
  private started = false;

  constructor(
    private readonly log: JobLog,
    private readonly queueName = "dads-api",
  ) {}

  register(jobs: readonly JobDefinition[]): void {
    if (this.started) {
      throw new Error("Jobs must be registered before the job queue starts");
    }
    this.registry.register(jobs);
  }

  start(): Promise<void> {
    if (this.started) {
      return Promise.reject(new Error("Job queue has already been started"));
    }
    this.started = true;
    try {
      for (const definition of this.registry.list()) {
        for (const schedule of definition.schedules) {
          const scheduled: ScheduledTimer = {
            jobName: definition.name,
            schedule,
            timer: undefined,
            nextRunAt: null,
          };
          this.timers.set(schedule.id, scheduled);
          this.scheduleNextRun(scheduled);
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
      return Promise.resolve();
    } catch (error) {
      this.cancelTimers();
      this.timers.clear();
      this.started = false;
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  enqueue(jobName: string, payload: unknown): Promise<void> {
    const definition = this.registry.get(jobName);
    this.counts = { ...this.counts, waiting: this.counts.waiting + 1 };
    const execution = Promise.resolve().then(() =>
      this.runJob(jobName, payload, definition),
    );
    this.activeRuns.add(execution);
    void execution.finally(() => {
      this.activeRuns.delete(execution);
    });
    return Promise.resolve();
  }

  inspect(): Promise<JobQueueInspection> {
    return Promise.resolve({
      driver: "in-process",
      queueName: this.queueName,
      jobs: describeJobs(this.registry.list()),
      schedules: [...this.timers.values()].map(describeRunningSchedule),
      counts: this.counts,
    });
  }

  async close(): Promise<void> {
    this.cancelTimers();
    await Promise.all([...this.activeRuns]);
  }

  private async runJob(
    jobName: string,
    payload: unknown,
    definition: JobDefinition,
  ): Promise<void> {
    this.counts = {
      ...this.counts,
      waiting: this.counts.waiting - 1,
      active: this.counts.active + 1,
    };
    // Nobody asked for this run, so it is attributed to the job itself.
    // The request id is logged because it is the only handle on
    // the `audit_log` rows one run produced.
    const actor = jobRunActor(jobName);
    this.log.info(
      { event: "job.started", jobName, requestId: actor.requestId },
      "job started",
    );
    try {
      await runWithAuditActor(actor, () => definition.run(payload));
      this.counts = {
        ...this.counts,
        active: this.counts.active - 1,
        completed: this.counts.completed + 1,
      };
      this.log.info({ event: "job.completed", jobName }, "job completed");
    } catch (error) {
      this.counts = {
        ...this.counts,
        active: this.counts.active - 1,
        failed: this.counts.failed + 1,
      };
      this.log.error(
        { event: "job.failed", jobName, err: error },
        "job failed",
      );
    }
  }

  private cancelTimers(): void {
    for (const scheduled of this.timers.values()) {
      if (scheduled.timer) {
        clearTimeout(scheduled.timer);
      }
      scheduled.timer = undefined;
      scheduled.nextRunAt = null;
    }
  }

  private scheduleNextRun(scheduled: ScheduledTimer): void {
    const now = Date.now();
    const next = nextRunMillis(now, scheduled.schedule);
    if (next === undefined) {
      throw new Error(`Schedule "${scheduled.schedule.id}" has no next run`);
    }
    scheduled.nextRunAt = new Date(next).toISOString();
    scheduled.timer = setTimeout(
      () => {
        scheduled.timer = undefined;
        scheduled.nextRunAt = null;
        void this.enqueue(scheduled.jobName, scheduled.schedule.payload);
        this.scheduleNextRun(scheduled);
      },
      Math.max(0, next - now),
    );
    scheduled.timer.unref();
  }
}

function nextRunMillis(
  now: number,
  schedule: JobSchedule<unknown>,
): number | undefined {
  if (schedule.kind === "interval") {
    return (Math.floor(now / schedule.everyMs) + 1) * schedule.everyMs;
  }
  const expression = cronParser.parseExpression(schedule.pattern, {
    currentDate: new Date(now),
    tz: schedule.timeZone,
  });
  try {
    return expression.next().getTime();
  } catch {
    return undefined;
  }
}

function describeRunningSchedule(
  scheduled: ScheduledTimer,
): RunningJobSchedule {
  if (scheduled.schedule.kind === "cron") {
    return {
      id: scheduled.schedule.id,
      jobName: scheduled.jobName,
      kind: scheduled.schedule.kind,
      pattern: scheduled.schedule.pattern,
      timeZone: scheduled.schedule.timeZone,
      nextRunAt: scheduled.nextRunAt,
    };
  }
  return {
    id: scheduled.schedule.id,
    jobName: scheduled.jobName,
    kind: scheduled.schedule.kind,
    everyMs: scheduled.schedule.everyMs,
    nextRunAt: scheduled.nextRunAt,
  };
}

function emptyCounts(): JobQueueCounts {
  return {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
  };
}
