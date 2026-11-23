/**
 * How many rows Postgres estimates each table holds. `pg_class.reltuples` is
 * the planner's estimate, kept current by autovacuum's ANALYZE: reading it is
 * one catalog lookup, never a scan, so the audit costs the same however large
 * the tables have grown.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleHandle } from "@dads-framework/postgres";

export abstract class CatalogSizeReader {
  /**
   * Estimated rows by table name, in the current schema. A table Postgres has
   * never analyzed (estimate `-1`) or does not have is left out: unknown is
   * not small, and the audit says which tables it could not size.
   */
  abstract estimatedRows(tableNames: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

const estimateRow = z.object({
  table_name: z.string(),
  estimated_rows: z.coerce.number(),
});

export class PostgresCatalogSizeReader extends CatalogSizeReader {
  constructor(private readonly db: DrizzleHandle) {
    super();
  }

  override async estimatedRows(tableNames: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (tableNames.length === 0) return new Map();
    const result = await this.db.execute(sql`
      SELECT c.relname AS table_name, c.reltuples::bigint AS estimated_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relkind IN ('r', 'p')
         AND c.relname = ANY(${sql.param([...tableNames])}::text[])
    `);
    const estimates = new Map<string, number>();
    for (const row of z.array(estimateRow).parse(result.rows)) {
      if (row.estimated_rows >= 0) {
        estimates.set(row.table_name, row.estimated_rows);
      }
    }
    return estimates;
  }
}
