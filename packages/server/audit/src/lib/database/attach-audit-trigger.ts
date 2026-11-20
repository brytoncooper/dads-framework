import type { MigrationBuilder } from "node-pg-migrate";

/**
 * The one statement that puts a table under audit.
 *
 * The migration that installed `audit_record` attached it to every table that
 * existed then, by looping over `pg_tables`. A table created afterwards has to
 * say so itself, and this is how: one call in the table's own migration, right
 * after `pgm.createTable`. Verify coverage against the application's table list.
 */

/**
 * The slice of `MigrationBuilder` these helpers use. Naming it keeps the
 * helper honest about what it touches and lets a unit test record the emitted
 * SQL without standing up the whole builder.
 */
export type AuditTriggerMigrationBuilder = Pick<MigrationBuilder, "sql">;

export type AuditTriggerOptions = {
  /**
   * The columns that name a row: the primary key, or the columns of a unique
   * index when the table has no primary key. They become the `row_key` object
   * on every audit row, so an empty list means audit can record that the row
   * changed but not which row it was.
   */
  keyColumns: readonly string[];
  /**
   * The uuid column that partitions the row by owner. Omitted when the table has none.
   */
  ownerColumn?: string;
  /** Scope dimension names mapped to columns on this table. */
  scopeColumns?: Readonly<Record<string, string>>;
};

/** Unquoted lowercase identifiers only; anything else is a mistake, loudly. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export function attachAuditTrigger(
  pgm: AuditTriggerMigrationBuilder,
  table: string,
  options: AuditTriggerOptions,
): void {
  requireAuditIdentifier(table, "table");
  for (const column of options.keyColumns) {
    requireAuditIdentifier(column, "key column");
  }
  if (options.ownerColumn !== undefined) {
    requireAuditIdentifier(options.ownerColumn, "owner column");
  }

  const keyColumns = options.keyColumns.join(",");
  const ownerColumn = options.ownerColumn ?? "";

  const scope = scopeTriggerArgument(pgm, table, options.scopeColumns);
  const target =
    options.scopeColumns === undefined ? `"${table}"` : `public."${table}"`;
  pgm.sql(
    `CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION audit_record('${keyColumns}', '${ownerColumn}'${scope})`,
  );
}

export function detachAuditTrigger(
  pgm: AuditTriggerMigrationBuilder,
  table: string,
): void {
  requireAuditIdentifier(table, "table");
  pgm.sql(`DROP TRIGGER audit_record ON "${table}"`);
}

function scopeTriggerArgument(
  pgm: AuditTriggerMigrationBuilder,
  table: string,
  scopeColumns: AuditTriggerOptions["scopeColumns"],
): string {
  if (scopeColumns === undefined) return "";
  const columns = Object.entries(scopeColumns);
  for (const [dimension, column] of columns) {
    requireAuditIdentifier(dimension, "scope dimension");
    requireAuditIdentifier(column, "scope column");
  }
  if (columns.length > 0) {
    const selected = columns.map(([, column]) => `"${column}"`).join(", ");
    pgm.sql(`SELECT ${selected} FROM public."${table}" LIMIT 0`);
  }
  return `, '${JSON.stringify(Object.fromEntries(columns))}'`;
}

export function requireAuditIdentifier(name: string, role: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `audit trigger ${role} "${name}" is not a plain lowercase identifier`,
    );
  }
}
