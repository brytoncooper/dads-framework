import { and, eq, sql, type SQL } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgTable,
  PgUpdateSetSource,
} from "drizzle-orm/pg-core";

import type { DrizzleHandle } from "../drizzle.js";

type RowVersionTransaction = Parameters<
  Parameters<DrizzleHandle["transaction"]>[0]
>[0];
type RowVersionColumn = {
  readonly rowVersion: AnyPgColumn<{
    data: number;
    notNull: true;
    columnType: "PgInteger";
  }>;
};

/**
 * Update a row and advance its version in the same statement. The caller's
 * predicate selects one row and carries the application scope. An empty
 * result means no row matched both predicates. Only the new version is returned.
 */
export function updateAtRowVersion<TTable extends PgTable & RowVersionColumn>(
  tx: RowVersionTransaction,
  table: TTable,
  input: {
    readonly where: SQL;
    readonly expectedRowVersion: number;
    readonly changes: Omit<PgUpdateSetSource<NoInfer<TTable>>, "rowVersion">;
  },
) {
  return tx
    .update(table)
    .set({ ...input.changes, rowVersion: sql`${table.rowVersion} + 1` })
    .where(and(input.where, eq(table.rowVersion, input.expectedRowVersion)))
    .returning({ rowVersion: table.rowVersion });
}
