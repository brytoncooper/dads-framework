/** The boundary for named and recurring work. */
import type { JobDefinition, JobDescription } from "./job-definition.js";

/** Minimal structured logger accepted by both queue adapters. */
export type JobLog = {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

/** One armed schedule and its next known execution time. */
export type RunningJobSchedule = {
  readonly id: string;
  readonly jobName: string;
  readonly kind: "cron" | "interval";
  readonly pattern?: string;
  readonly timeZone?: string;
  readonly everyMs?: number;
  readonly nextRunAt: string | null;
};

/** Current queue totals; BullMQ totals cover only retained history. */
export type JobQueueCounts = {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly completed: number;
  readonly failed: number;
};

/** Static inventory plus live runtime state for one application queue. */
export type JobQueueInspection = {
  readonly driver: "in-process" | "bullmq";
  /** Stable application namespace owning this queue and its schedules. */
  readonly queueName: string;
  readonly jobs: readonly JobDescription[];
  readonly schedules: readonly RunningJobSchedule[];
  readonly counts: JobQueueCounts;
};

export abstract class JobQueue {
  /** Bind definitions before start. Names and schedule ids are globally unique. */
  abstract register(jobs: readonly JobDefinition[]): void;
  /** Reconcile recurring schedules and begin consuming work. */
  abstract start(): Promise<void>;
  /** Accept named work. Resolves when queued, not when the run finishes. */
  abstract enqueue(jobName: string, payload: unknown): Promise<void>;
  /** Inspect definitions, schedules, and progress without exposing payloads. */
  abstract inspect(): Promise<JobQueueInspection>;
  /** Cancel local timers and release the worker and queue. */
  abstract close(): Promise<void>;
}
