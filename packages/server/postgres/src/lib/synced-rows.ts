import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { DrizzleHandle } from "../drizzle.js";

/** The transaction a page of synced rows is written in; the caller owns its commit. */
export type SyncedRowTransaction = Parameters<
  Parameters<DrizzleHandle["transaction"]>[0]
>[0];

/**
 * One row of a copy kept in step with another database, as that database
 * has it now. `data` is the row's fields as sent, parsed by the table's
 * owner when written. `takeNext` writes the row whatever its stored
 * version; otherwise an upsert writes only a newer version, or the same
 * version with other values.
 */
export type SyncedRowChange<Table extends string> =
  | {
      readonly table: Table;
      readonly op: "upsert";
      readonly id: string;
      readonly rowVersion: number;
      readonly data: unknown;
      readonly takeNext: boolean;
    }
  | {
      readonly table: Table;
      readonly op: "delete";
      readonly id: string;
      readonly takeNext: boolean;
    };

/**
 * - `applied`: the row was written or deleted.
 * - `already_current`: the stored row is newer, or the same version with the same values.
 * - `missing_parent`: a row it points at is not here yet; nothing was written.
 * - `refused`: the database or the owner refused it; `code` says why.
 */
export type SyncedRowOutcome<Table extends string> = {
  readonly table: Table;
  readonly id: string;
  readonly outcome:
    "applied" | "already_current" | "missing_parent" | "refused";
  readonly code: string | null;
};

/** Written by an upsert whose data the owner could not read; nothing was stored. */
export const SYNCED_VALUE_UNKNOWN = "unknown_value";

/**
 * Written by an upsert to an append-only table whose stored row, under the
 * same id, holds other values. Such a row is never changed, so nothing was
 * stored; the outcome is `refused` with `SYNC_IMMUTABLE_ROW_DIFFERS`.
 */
export const SYNCED_ROW_IMMUTABLE_DIFFERS = "immutable_row_differs";

/**
 * How one owner writes its tables: true when a row was written or deleted.
 * `Tx` is the page's transaction; only a test names another.
 */
export type SyncedRowWriter<Table extends string, Tx = SyncedRowTransaction> = {
  upsert(
    tx: Tx,
    change: Extract<SyncedRowChange<Table>, { op: "upsert" }>,
  ): Promise<
    boolean | typeof SYNCED_VALUE_UNKNOWN | typeof SYNCED_ROW_IMMUTABLE_DIFFERS
  >;
  delete(tx: Tx, table: Table, id: string): Promise<boolean>;
  /**
   * Moves aside the other stored rows holding a unique value this upsert
   * carries (a name or code the cloud has since given to this row), to a
   * value nothing else holds, keeping their row version so their own cloud
   * row still applies. Answers how many it moved. A table whose unique
   * values cannot trade places leaves it out.
   */
  moveKeyHoldersAside?(
    tx: Tx,
    change: Extract<SyncedRowChange<Table>, { op: "upsert" }>,
  ): Promise<number>;
};

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

/**
 * Writes one page of synced rows inside the caller's transaction: upserts
 * parents first, then deletes children first, whatever order the page
 * used. Each change runs in its own savepoint and answers one outcome, in
 * that written order. An upsert whose parent is not here answers
 * `missing_parent`; a delete whose children stay answers `refused` with
 * `SYNC_ROW_HAS_CHILDREN`; data the owner cannot read answers `refused`
 * with `SYNC_VALUE_UNKNOWN`; an append-only row the owner holds with other
 * values answers `refused` with `SYNC_IMMUTABLE_ROW_DIFFERS`. An upsert whose unique value another stored
 * row still holds first moves that stale row aside, when the owner can
 * (`moveKeyHoldersAside`), and is written. Otherwise it answers
 * `missing_parent` with `SYNC_ROW_KEY_TAKEN`: that row is one the cloud has
 * since deleted or changed, and its own change runs after this one (deletes
 * run last), so the held row is retried once it has gone, never dropped.
 * One whose parent turns out to be missing once the key is free answers
 * `missing_parent`, with the move rolled back.
 */
export async function applySyncedRows<Table extends string>(
  tx: SyncedRowTransaction,
  changes: readonly SyncedRowChange<Table>[],
  tablesParentsFirst: readonly Table[],
  writer: SyncedRowWriter<Table>,
): Promise<SyncedRowOutcome<Table>[]> {
  const outcomes: SyncedRowOutcome<Table>[] = [];
  for (const change of writeOrder(changes, tablesParentsFirst)) {
    outcomes.push(await applyOne(tx, change, writer));
  }
  return outcomes;
}

async function applyOne<Table extends string>(
  tx: SyncedRowTransaction,
  change: SyncedRowChange<Table>,
  writer: SyncedRowWriter<Table>,
): Promise<SyncedRowOutcome<Table>> {
  const outcome = (
    result: SyncedRowOutcome<Table>["outcome"],
    code: string | null,
  ): SyncedRowOutcome<Table> => ({
    table: change.table,
    id: change.id,
    outcome: result,
    code,
  });
  try {
    const written = await tx.transaction((savepoint) =>
      change.op === "delete"
        ? writer.delete(savepoint, change.table, change.id)
        : writer.upsert(savepoint, change),
    );
    if (written === SYNCED_VALUE_UNKNOWN)
      return outcome("refused", "SYNC_VALUE_UNKNOWN");
    if (written === SYNCED_ROW_IMMUTABLE_DIFFERS)
      return outcome("refused", "SYNC_IMMUTABLE_ROW_DIFFERS");
    return outcome(written ? "applied" : "already_current", null);
  } catch (error) {
    const code = sqlStateOf(error);
    if (code === FOREIGN_KEY_VIOLATION) {
      return change.op === "upsert"
        ? outcome("missing_parent", null)
        : outcome("refused", "SYNC_ROW_HAS_CHILDREN");
    }
    if (code === UNIQUE_VIOLATION && change.op === "upsert") {
      const moved = await afterMovingAside(tx, change, writer);
      return outcome(moved.outcome, moved.code);
    }
    return outcome("refused", code ?? "SYNC_ROW_REFUSED");
  }
}

/**
 * The cloud owns its unique values: a stored row that still holds one this
 * upsert carries is stale, so it moves aside and the upsert is written, both
 * in one savepoint. Rows that trade values (two scales swapping names) then
 * converge whatever page each one's change arrives in. Held with
 * `SYNC_ROW_KEY_TAKEN`, writing nothing, when the owner moves nothing or the
 * write still collides; held as a plain `missing_parent` when the write,
 * once the key is free, finds its parent is not here yet (the unique check
 * runs before the foreign key's). Either way the savepoint rolls the move
 * back, so the stale row stays as it was and the held row is retried later,
 * never failing the page.
 */
async function afterMovingAside<Table extends string>(
  tx: SyncedRowTransaction,
  change: Extract<SyncedRowChange<Table>, { op: "upsert" }>,
  writer: SyncedRowWriter<Table>,
): Promise<Pick<SyncedRowOutcome<Table>, "outcome" | "code">> {
  const keyTaken: Pick<SyncedRowOutcome<Table>, "outcome" | "code"> = {
    outcome: "missing_parent",
    code: "SYNC_ROW_KEY_TAKEN",
  };
  if (writer.moveKeyHoldersAside === undefined) return keyTaken;
  try {
    await tx.transaction(async (savepoint) => {
      const moved = await writer.moveKeyHoldersAside?.(savepoint, change);
      // Nothing written: roll the move back with the savepoint.
      if (moved === undefined || moved === 0) throw new NotWrittenAfterMove();
      if ((await writer.upsert(savepoint, change)) !== true)
        throw new NotWrittenAfterMove();
    });
    return { outcome: "applied", code: null };
  } catch (error) {
    if (error instanceof NotWrittenAfterMove) return keyTaken;
    const code = sqlStateOf(error);
    if (code === UNIQUE_VIOLATION) return keyTaken;
    if (code === FOREIGN_KEY_VIOLATION)
      return { outcome: "missing_parent", code: null };
    throw error;
  }
}

/** Rolls back a move aside whose upsert did not write. */
class NotWrittenAfterMove extends Error {}

/** Upserts parents first, then deletes children first; page order within a table. */
function writeOrder<Table extends string>(
  changes: readonly SyncedRowChange<Table>[],
  tablesParentsFirst: readonly Table[],
): SyncedRowChange<Table>[] {
  const ordered: SyncedRowChange<Table>[] = [];
  for (const table of tablesParentsFirst) {
    ordered.push(
      ...changes.filter((c) => c.op === "upsert" && c.table === table),
    );
  }
  for (const table of [...tablesParentsFirst].reverse()) {
    ordered.push(
      ...changes.filter((c) => c.op === "delete" && c.table === table),
    );
  }
  return ordered;
}

/**
 * The stored row is older, or holds the same version with other values. A
 * same-version row with the same values is left alone, so a repeated page
 * writes nothing (no audit or sync log row either). Undefined when the
 * caller takes the next row whatever its version.
 */
export function newerOrDifferent(
  rowVersion: AnyPgColumn,
  synced: readonly AnyPgColumn[],
  takeNext = false,
): SQL | undefined {
  if (takeNext) return undefined;
  const stored = sql.join(
    synced.map((column) => sql`${column}`),
    sql`, `,
  );
  const sent = sql.join(synced.map(excluded), sql`, `);
  return sql`${rowVersion} < ${excluded(rowVersion)} OR (${rowVersion} = ${excluded(rowVersion)} AND (${stored}) IS DISTINCT FROM (${sent}))`;
}

/** The value an `INSERT … ON CONFLICT` proposed for `column`. */
export function excluded(column: AnyPgColumn): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/** Each named column's proposed value, under the same names: an `ON CONFLICT` `set`. */
export function excludedAll<Name extends string>(
  columns: Readonly<Record<Name, AnyPgColumn>>,
): Partial<Record<Name, SQL>> {
  const set: Partial<Record<Name, SQL>> = {};
  for (const name of Object.keys(columns).filter((key): key is Name =>
    Object.hasOwn(columns, key),
  )) {
    set[name] = excluded(columns[name]);
  }
  return set;
}

/** The SQLSTATE of a refused statement; drizzle wraps the driver error in `cause`. */
export function sqlStateOf(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = Reflect.get(current, "cause");
  }
  return null;
}
