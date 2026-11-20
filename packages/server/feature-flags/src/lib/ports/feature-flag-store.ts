import type {
  FeatureFlagHistoryEntry,
  FeatureFlagState,
} from "../../contract/index.js";

export type FeatureFlagBatchWrite = {
  readonly expectedRevisions: ReadonlyMap<string, number>;
  readonly nextStates: readonly FeatureFlagState[];
  readonly history: readonly FeatureFlagHistoryEntry[];
};

export type FeatureFlagHistoryPage = {
  readonly rows: readonly FeatureFlagHistoryEntry[];
  readonly total: number;
};

/**
 * Where audience state and its history are kept. Absorbs the storage engine:
 * `@dads-framework/feature-flags-postgres` is one, the testing fake another.
 * Its one write is all or nothing.
 */
export abstract class FeatureFlagStore {
  /** Stored states for these slugs; a slug with no row is simply absent. */
  abstract listStates(
    slugs: readonly string[],
  ): Promise<readonly FeatureFlagState[]>;

  /** One page of a flag's history, highest revision first. */
  abstract listHistory(input: {
    readonly slug: string;
    readonly page: number;
    readonly perPage: number;
  }): Promise<FeatureFlagHistoryPage>;

  /** A stale expected revision rolls back every state and history row in the batch. */
  abstract applyBatch(
    input: FeatureFlagBatchWrite,
  ): Promise<"applied" | "revision-conflict">;
}
