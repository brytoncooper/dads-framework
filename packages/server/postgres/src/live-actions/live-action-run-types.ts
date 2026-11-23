import type {
  FinishLiveActionRunInput,
  ListRecentLiveActionRunsOptions,
  LiveActionDangerLevel,
  LiveActionRedactedInput,
  LiveActionRunOutcome,
  LiveActionRunRecord,
  LiveActionRunStore,
} from "@dads-framework/core/contract";

/** Minimal queryable PostgreSQL pool or client surface used by the live-action store. */
export type LiveActionQueryClient = {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
};

export type {
  FinishLiveActionRunInput,
  ListRecentLiveActionRunsOptions,
  LiveActionDangerLevel,
  LiveActionRedactedInput,
  LiveActionRunOutcome,
  LiveActionRunRecord,
  LiveActionRunStore,
};
