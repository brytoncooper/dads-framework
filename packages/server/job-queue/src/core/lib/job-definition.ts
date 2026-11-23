/** Retry contract shared by every driver; attempts includes the first run. */
export type JobRetryPolicy = {
  /** Total attempts including the first run. */
  readonly attempts: number;
  /** Base delay in milliseconds; BullMQ applies exponential backoff. */
  readonly backoffMs: number;
};

/** Stable cron trigger and the payload enqueued at each occurrence. */
export type CronJobSchedule<Payload> = {
  readonly id: string;
  readonly kind: "cron";
  readonly pattern: string;
  readonly timeZone: string;
  readonly payload: Payload;
};

/** Fixed-millisecond trigger and the payload enqueued at each occurrence. */
export type IntervalJobSchedule<Payload> = {
  readonly id: string;
  readonly kind: "interval";
  readonly everyMs: number;
  readonly payload: Payload;
};

/** A recurring cron or fixed-interval trigger for one job. */
export type JobSchedule<Payload> = CronJobSchedule<Payload> | IntervalJobSchedule<Payload>;

/** Runtime-ready job edge after its payload type has been safely erased. */
export type JobDefinition = {
  readonly name: string;
  readonly retry: JobRetryPolicy;
  readonly schedules: readonly JobSchedule<unknown>[];
  readonly run: (payload: unknown) => Promise<void>;
};

/** Payload-free job inventory safe for diagnostics and generated artifacts. */
export type JobDescription = {
  readonly name: string;
  readonly retry: JobRetryPolicy;
  readonly schedules: readonly JobScheduleDescription[];
};

/** Payload-free cron or interval metadata exposed by inspection. */
export type JobScheduleDescription =
  Omit<CronJobSchedule<unknown>, "payload"> | Omit<IntervalJobSchedule<unknown>, "payload">;

type PayloadSchema<Payload> = {
  parse(payload: unknown): Payload;
};

type DefineJobOptions<Payload> = {
  readonly name: string;
  readonly payload: PayloadSchema<Payload>;
  readonly retry: JobRetryPolicy;
  readonly schedules: readonly JobSchedule<Payload>[];
  readonly run: (payload: Payload) => Promise<void>;
};

/** Bind a stable name, payload parser, retry policy, schedules, and operation. */
export function defineJob<Payload>(options: DefineJobOptions<Payload>): JobDefinition {
  requireName("Job", options.name);
  requirePositiveInteger("retry attempts", options.retry.attempts);
  requirePositiveInteger("retry backoffMs", options.retry.backoffMs);
  return {
    name: options.name,
    retry: options.retry,
    schedules: options.schedules,
    run: async (payload) => {
      await options.run(options.payload.parse(payload));
    },
  };
}

/** Declare a cron schedule beside the job it invokes. */
export function cronSchedule<Payload>(schedule: Omit<CronJobSchedule<Payload>, "kind">): CronJobSchedule<Payload> {
  requireName("Schedule", schedule.id);
  requireName("Cron pattern", schedule.pattern);
  requireName("Time zone", schedule.timeZone);
  return { ...schedule, kind: "cron" };
}

/** Declare a fixed interval schedule beside the job it invokes. */
export function intervalSchedule<Payload>(
  schedule: Omit<IntervalJobSchedule<Payload>, "kind">,
): IntervalJobSchedule<Payload> {
  requireName("Schedule", schedule.id);
  requirePositiveInteger("schedule everyMs", schedule.everyMs);
  return { ...schedule, kind: "interval" };
}

/** Return the safe, static inventory used by diagnostics and operator tooling. */
export function describeJobs(definitions: readonly JobDefinition[]): readonly JobDescription[] {
  return definitions.map((definition) => ({
    name: definition.name,
    retry: definition.retry,
    schedules: definition.schedules.map(describeSchedule),
  }));
}

function describeSchedule(schedule: JobSchedule<unknown>): JobScheduleDescription {
  if (schedule.kind === "cron") {
    return {
      id: schedule.id,
      kind: schedule.kind,
      pattern: schedule.pattern,
      timeZone: schedule.timeZone,
    };
  }
  return {
    id: schedule.id,
    kind: schedule.kind,
    everyMs: schedule.everyMs,
  };
}

function requireName(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function requirePositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
