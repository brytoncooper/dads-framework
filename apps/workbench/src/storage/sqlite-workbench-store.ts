import { DatabaseSync } from "node:sqlite";
import { SnapshotWorkbenchStore } from "./workbench-store.js";
import { emptyWorkbenchState, workbenchState, type WorkbenchState } from "./workbench-state.js";

/** A single-process local store: resource state and the relationship outbox share one SQLite commit. */
export class SqliteWorkbenchStore extends SnapshotWorkbenchStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    super();
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS workbench_state (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL) STRICT",
    );
    this.database
      .prepare("INSERT OR IGNORE INTO workbench_state (id, document) VALUES (1, ?)")
      .run(JSON.stringify(emptyWorkbenchState()));
    this.readState();
  }

  read(): Promise<WorkbenchState> {
    try {
      return Promise.resolve(this.readState());
    } catch (error: unknown) {
      return rejectedSqliteStoreOperation(error);
    }
  }

  private readState(): WorkbenchState {
    const row = this.database.prepare("SELECT document FROM workbench_state WHERE id = 1").get();
    if (!row || typeof row["document"] !== "string") throw new Error("Workbench state is missing or invalid.");
    const parsed: unknown = JSON.parse(row["document"]);
    return workbenchState.parse(parsed);
  }

  transaction<Result>(change: (state: WorkbenchState) => Result): Promise<Result> {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const state = this.readState();
      const result = change(state);
      const validated = workbenchState.parse(state);
      this.database.prepare("UPDATE workbench_state SET document = ? WHERE id = 1").run(JSON.stringify(validated));
      this.database.exec("COMMIT");
      return Promise.resolve(result);
    } catch (error: unknown) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // BEGIN failures have no open transaction; preserve the useful cause.
      }
      return rejectedSqliteStoreOperation(error);
    }
  }

  close(): void {
    this.database.close();
  }
}

/** The SQLite store's failure wrapper; `memory-workbench-store.ts` has `rejectedMemoryStoreOperation`. */
function rejectedSqliteStoreOperation<Result>(error: unknown): Promise<Result> {
  return Promise.reject(
    error instanceof Error ? error : new Error("Workbench SQLite storage failed.", { cause: error }),
  );
}
