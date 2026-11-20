import type {
  FeatureFlagHistoryEntry,
  FeatureFlagState,
} from "../contract/index.js";
import {
  type FeatureFlagBatchWrite,
  type FeatureFlagHistoryPage,
  FeatureFlagStore,
} from "../lib/ports/feature-flag-store.js";

/** The in-memory store: the same all-or-nothing batch as Postgres, for tests without a database. */
export class InMemoryFeatureFlagStore extends FeatureFlagStore {
  private states = new Map<string, FeatureFlagState>();
  private readonly history: FeatureFlagHistoryEntry[] = [];

  seed(states: readonly FeatureFlagState[]): void {
    this.states = new Map(states.map((state) => [state.slug, state]));
  }

  listStates(slugs: readonly string[]): Promise<readonly FeatureFlagState[]> {
    return Promise.resolve(
      slugs.flatMap((slug) => {
        const state = this.states.get(slug);
        return state === undefined ? [] : [state];
      }),
    );
  }

  listHistory(input: {
    readonly slug: string;
    readonly page: number;
    readonly perPage: number;
  }): Promise<FeatureFlagHistoryPage> {
    const rows = this.history
      .filter((entry) => entry.slug === input.slug)
      .sort((a, b) => b.revision - a.revision);
    return Promise.resolve({
      rows: rows.slice(
        (input.page - 1) * input.perPage,
        input.page * input.perPage,
      ),
      total: rows.length,
    });
  }

  applyBatch(
    input: FeatureFlagBatchWrite,
  ): Promise<"applied" | "revision-conflict"> {
    for (const [slug, expectedRevision] of input.expectedRevisions) {
      if ((this.states.get(slug)?.revision ?? 0) !== expectedRevision) {
        return Promise.resolve("revision-conflict");
      }
    }
    for (const state of input.nextStates) this.states.set(state.slug, state);
    this.history.push(...input.history);
    return Promise.resolve("applied");
  }
}
