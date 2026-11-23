/** Shared persistence contract for audited live operational action runs. */

export type LiveActionDangerLevel = "safe" | "cautious" | "destructive";

export type LiveActionRunOutcome = "running" | "succeeded" | "failed";

/** JSON-serializable snapshot of a live action's redacted input payload. */
export type LiveActionRedactedInput =
  | null
  | boolean
  | number
  | string
  | readonly LiveActionRedactedInput[]
  | { readonly [key: string]: LiveActionRedactedInput };

/** Persisted audit record for one live action execution. */
export type LiveActionRunRecord = {
  readonly id: string;
  readonly actionName: string;
  readonly dangerLevel: LiveActionDangerLevel;
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

/** Persistence seam shared by HTTP live-action routes and storage adapters. */
export type LiveActionRunStore = {
  recordStart(run: LiveActionRunRecord): Promise<void>;
  recordFinish(input: FinishLiveActionRunInput): Promise<void>;
  getById(id: string): Promise<LiveActionRunRecord | undefined>;
  listRecent(options?: ListRecentLiveActionRunsOptions): Promise<readonly LiveActionRunRecord[]>;
};
