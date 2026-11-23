/** Minimal queryable PostgreSQL pool or client surface used by the live-action store. */
export type LiveActionQueryClient = {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
};

export type LiveActionRunOutcome = "running" | "succeeded" | "failed";

/** JSON-serializable snapshot of a live action's redacted input payload. */
export type LiveActionRedactedInput =
  | null
  | boolean
  | number
  | string
  | readonly LiveActionRedactedInput[]
  | { readonly [key: string]: LiveActionRedactedInput };

export type LiveActionRunRecord = {
  readonly id: string;
  readonly actionName: string;
  readonly dangerLevel: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly reason: string;
  readonly redactedInput: unknown;
  readonly outcome: LiveActionRunOutcome;
  readonly summary: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
};

export type FinishLiveActionRunInput = {
  readonly id: string;
  readonly outcome: "succeeded" | "failed";
  readonly summary: string | null;
  readonly errorMessage: string | null;
  readonly finishedAt: Date;
};

export type ListRecentLiveActionRunsOptions = {
  readonly actionName?: string;
  readonly limit?: number;
};

export type LiveActionRunStore = {
  recordStart(run: LiveActionRunRecord): Promise<void>;
  recordFinish(input: FinishLiveActionRunInput): Promise<void>;
  getById(id: string): Promise<LiveActionRunRecord | undefined>;
  listRecent(options?: ListRecentLiveActionRunsOptions): Promise<readonly LiveActionRunRecord[]>;
};
