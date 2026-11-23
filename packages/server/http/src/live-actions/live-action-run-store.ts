import type {
  FinishLiveActionRunInput,
  ListRecentLiveActionRunsOptions,
  LiveActionRunRecord,
  LiveActionRunStore,
} from "@dads-framework/core/contract";

export type { FinishLiveActionRunInput, LiveActionRunRecord, LiveActionRunStore };
export type ListLiveActionRunsOptions = ListRecentLiveActionRunsOptions;

type StoredEntry = {
  readonly sequence: number;
  readonly record: LiveActionRunRecord;
};

/**
 * In-memory implementation of {@link LiveActionRunStore} for tests and
 * single-process deployments.
 */
export class InMemoryLiveActionRunStore implements LiveActionRunStore {
  private readonly entries = new Map<string, StoredEntry>();
  private nextSequence = 0;

  recordStart(run: LiveActionRunRecord): Promise<void> {
    if (this.entries.has(run.id)) {
      return Promise.reject(new Error(`Live action run "${run.id}" already exists`));
    }
    this.nextSequence += 1;
    this.entries.set(run.id, {
      sequence: this.nextSequence,
      record: { ...run },
    });
    return Promise.resolve();
  }

  recordFinish(input: FinishLiveActionRunInput): Promise<void> {
    const existing = this.entries.get(input.id);
    if (existing === undefined) {
      return Promise.reject(new Error(`Live action run "${input.id}" does not exist`));
    }
    this.entries.set(input.id, {
      sequence: existing.sequence,
      record: {
        ...existing.record,
        outcome: input.outcome,
        summary: input.summary,
        errorMessage: input.errorMessage,
        finishedAt: input.finishedAt,
      },
    });
    return Promise.resolve();
  }

  getById(id: string): Promise<LiveActionRunRecord | undefined> {
    const entry = this.entries.get(id);
    return Promise.resolve(entry === undefined ? undefined : { ...entry.record });
  }

  listRecent(options: ListLiveActionRunsOptions = {}): Promise<readonly LiveActionRunRecord[]> {
    const filtered = [...this.entries.values()].filter(
      (entry) => options.actionName === undefined || entry.record.actionName === options.actionName,
    );
    filtered.sort(
      (left, right) =>
        right.record.startedAt.getTime() - left.record.startedAt.getTime() || right.sequence - left.sequence,
    );
    const limited = options.limit === undefined ? filtered : filtered.slice(0, Math.max(0, Math.floor(options.limit)));
    return Promise.resolve(limited.map((entry) => ({ ...entry.record })));
  }
}
