import type { JobDefinition } from "./job-definition.js";

/** Owns the uniqueness rules shared by every job driver. */
export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();
  private readonly scheduleIds = new Set<string>();

  register(jobs: readonly JobDefinition[]): void {
    this.validate(jobs);
    for (const job of jobs) {
      this.definitions.set(job.name, job);
      for (const schedule of job.schedules) {
        this.scheduleIds.add(schedule.id);
      }
    }
  }

  get(jobName: string): JobDefinition {
    const definition = this.definitions.get(jobName);
    if (!definition) {
      throw new Error(`No handler registered for job "${jobName}"`);
    }
    return definition;
  }

  list(): readonly JobDefinition[] {
    return [...this.definitions.values()];
  }

  private validate(jobs: readonly JobDefinition[]): void {
    const names = new Set(this.definitions.keys());
    const scheduleIds = new Set(this.scheduleIds);
    for (const job of jobs) {
      if (names.has(job.name)) {
        throw new Error(`Job "${job.name}" already has a handler`);
      }
      names.add(job.name);
      for (const schedule of job.schedules) {
        if (scheduleIds.has(schedule.id)) {
          throw new Error(
            `Schedule "${schedule.id}" is registered more than once`,
          );
        }
        scheduleIds.add(schedule.id);
      }
    }
  }
}
