import { SnapshotWorkbenchStore } from "./workbench-store.js";
import {
  emptyWorkbenchState,
  workbenchState,
  type WorkbenchState,
} from "./workbench-state.js";

/** Deterministic substitute for SQLite, with the same detached-snapshot and atomic-write behavior. */
export class MemoryWorkbenchStore extends SnapshotWorkbenchStore {
  protected state = emptyWorkbenchState();

  read(): Promise<WorkbenchState> {
    try {
      return Promise.resolve(workbenchState.parse(this.state));
    } catch (error: unknown) {
      return rejectedMemoryStoreOperation(error);
    }
  }

  transaction<Result>(
    change: (state: WorkbenchState) => Result,
  ): Promise<Result> {
    try {
      const next = workbenchState.parse(this.state);
      const result = change(next);
      this.state = workbenchState.parse(next);
      return Promise.resolve(result);
    } catch (error: unknown) {
      return rejectedMemoryStoreOperation(error);
    }
  }
}

/** The memory store's failure wrapper; `sqlite-workbench-store.ts` has `rejectedSqliteStoreOperation`. */
function rejectedMemoryStoreOperation<Result>(error: unknown): Promise<Result> {
  return Promise.reject(
    error instanceof Error
      ? error
      : new Error("Workbench memory storage failed.", { cause: error }),
  );
}
