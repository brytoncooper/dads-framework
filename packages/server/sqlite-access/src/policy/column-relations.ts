import type { RoleToken } from "@dads-framework/access";
import type { SqliteExecutor } from "../sqlite-executor.js";
import type {
  CompiledSqliteColumnRelation,
  SqliteAuthorizationModel,
} from "./policy-model.js";

const SQL_COLUMN_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SQL_TABLE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Public binding declaring that a single-target FK relation lives directly on a SQLite application table. */
export type SqliteColumnRelationBinding = {
  readonly role: RoleToken;
  /** Unquoted SQLite table name (e.g. `"documents"`). */
  readonly table: string;
  /** Primary key column storing the resource ID (e.g. `"id"`). */
  readonly idColumn: string;
  /** Foreign-key column storing the target ID (e.g. `"org_id"`, `"parent_id"`, or `"owner_id"`). */
  readonly targetIdColumn: string;
};

/** Verification status for one SQLite column-backed relation against the live schema. */
export type SqliteColumnRelationCheckResult = {
  readonly entity: string;
  readonly relation: string;
  readonly table: string;
  readonly idColumn: string;
  readonly targetIdColumn: string;
  readonly hasRecommendedIndex: boolean;
  readonly recommendedIndexSql: string;
};

function assertSafeIdentifier(
  value: string,
  pattern: RegExp,
  label: string,
): void {
  if (!pattern.test(value)) {
    throw new Error(
      `Invalid SQLite columnRelation ${label} "${value}": must be an unquoted SQL identifier`,
    );
  }
}

/** Validate and compile `columnRelations` bindings against the lowered SQLite model. */
export function compileSqliteColumnRelations(
  model: Pick<SqliteAuthorizationModel, "relations">,
  bindings: readonly SqliteColumnRelationBinding[] | undefined,
): readonly CompiledSqliteColumnRelation[] {
  if (bindings === undefined || bindings.length === 0) return [];
  const seen = new Set<string>();
  const compiled: CompiledSqliteColumnRelation[] = [];
  for (const binding of bindings) {
    compiled.push(compileSingleBinding(model, binding, seen));
  }
  return Object.freeze(compiled);
}

function compileSingleBinding(
  model: Pick<SqliteAuthorizationModel, "relations">,
  binding: SqliteColumnRelationBinding,
  seen: Set<string>,
): CompiledSqliteColumnRelation {
  const entity = binding.role.entityWireName;
  const relation = binding.role.roleName;
  const key = `${entity}\u0000${relation}`;
  if (seen.has(key)) {
    throw new Error(
      `Duplicate SQLite columnRelation binding for ${entity}#${relation}`,
    );
  }
  seen.add(key);

  assertSafeIdentifier(binding.table, SQL_TABLE_IDENT, "table");
  assertSafeIdentifier(binding.idColumn, SQL_COLUMN_IDENT, "idColumn");
  assertSafeIdentifier(
    binding.targetIdColumn,
    SQL_COLUMN_IDENT,
    "targetIdColumn",
  );

  const relDef = model.relations.find(
    (candidate) =>
      candidate.entity === entity && candidate.wireName === relation,
  );
  if (relDef === undefined) {
    throw new Error(
      `SQLite column relation ${entity}#${relation} does not exist in the compiled access model`,
    );
  }
  const onlyTarget =
    relDef.targets.length === 1 ? relDef.targets[0] : undefined;
  if (onlyTarget === undefined || onlyTarget.kind !== "entity") {
    throw new Error(
      `SQLite column relation ${entity}#${relation} must declare exactly one direct entity target (no polymorphic, wildcard, or userset targets)`,
    );
  }
  return Object.freeze({
    entity,
    relation,
    targetEntity: onlyTarget.entity,
    table: binding.table,
    idColumn: binding.idColumn,
    targetIdColumn: binding.targetIdColumn,
  });
}

/** Look up a column-backed relation binding by `(entity, relation)`. */
export function findSqliteColumnRelation(
  model: SqliteAuthorizationModel,
  entity: string,
  relation: string,
): CompiledSqliteColumnRelation | undefined {
  return model.columnRelations?.find(
    (entry) => entry.entity === entity && entry.relation === relation,
  );
}

/** Generate recommended `(targetIdColumn, idColumn)` reverse-lookup index DDL for SQLite column-backed relations. */
export function sqliteColumnRelationIndexSql(
  bindings: readonly SqliteColumnRelationBinding[],
): readonly string[] {
  return bindings.map((binding) => {
    assertSafeIdentifier(binding.table, SQL_TABLE_IDENT, "table");
    assertSafeIdentifier(binding.idColumn, SQL_COLUMN_IDENT, "idColumn");
    assertSafeIdentifier(
      binding.targetIdColumn,
      SQL_COLUMN_IDENT,
      "targetIdColumn",
    );
    const indexName = `idx_dad_${binding.table}_${binding.targetIdColumn}_${binding.idColumn}`;
    return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${binding.table} (${binding.targetIdColumn}, ${binding.idColumn});`;
  });
}

/** Auto-derive `scopeColumns` from `columnRelations` on `resourceType` matching `idColumn`'s table prefix. */
export function deriveAutoSqliteScopeColumns(
  model: SqliteAuthorizationModel,
  resourceType: string,
  idColumn: string,
): Readonly<Record<string, string>> | undefined {
  const bindings = model.columnRelations?.filter(
    (entry) => entry.entity === resourceType,
  );
  if (bindings === undefined || bindings.length === 0) return undefined;
  const dotIndex = idColumn.indexOf(".");
  const prefix = dotIndex === -1 ? "" : `${idColumn.slice(0, dotIndex)}.`;
  const derived: Record<string, string> = {};
  for (const binding of bindings) {
    derived[binding.relation] = `${prefix}${binding.targetIdColumn}`;
  }
  return derived;
}

function readText(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/** Verify every SQLite column-backed table and column exists and report index status. */
export async function verifySqliteColumnRelations(
  relations: readonly CompiledSqliteColumnRelation[],
  executor: SqliteExecutor,
): Promise<readonly SqliteColumnRelationCheckResult[]> {
  const results: SqliteColumnRelationCheckResult[] = [];
  for (const binding of relations) {
    results.push(await verifyOneSqliteColumnRelation(binding, executor));
  }
  return results;
}

async function verifyOneSqliteColumnRelation(
  binding: CompiledSqliteColumnRelation,
  executor: SqliteExecutor,
): Promise<SqliteColumnRelationCheckResult> {
  const tableRows = await executor.all(
    `PRAGMA table_info(${binding.table})`,
    [],
  );
  const columns = new Set(tableRows.map((row) => readText(row, "name")));
  for (const required of [binding.idColumn, binding.targetIdColumn]) {
    if (!columns.has(required)) {
      throw new Error(
        `SQLite column relation ${binding.entity}#${binding.relation} expects column "${binding.table}.${required}", which does not exist`,
      );
    }
  }
  const hasRecommendedIndex = await hasLeadingTargetIndex(binding, executor);
  const indexName = `idx_dad_${binding.table}_${binding.targetIdColumn}_${binding.idColumn}`;
  return {
    entity: binding.entity,
    relation: binding.relation,
    table: binding.table,
    idColumn: binding.idColumn,
    targetIdColumn: binding.targetIdColumn,
    hasRecommendedIndex,
    recommendedIndexSql: `CREATE INDEX IF NOT EXISTS ${indexName} ON ${binding.table} (${binding.targetIdColumn}, ${binding.idColumn});`,
  };
}

async function hasLeadingTargetIndex(
  binding: CompiledSqliteColumnRelation,
  executor: SqliteExecutor,
): Promise<boolean> {
  const indexes = await executor.all(`PRAGMA index_list(${binding.table})`, []);
  for (const indexRow of indexes) {
    const indexName = readText(indexRow, "name");
    if (!SQL_COLUMN_IDENT.test(indexName)) continue;
    const infoRows = await executor.all(`PRAGMA index_info(${indexName})`, []);
    const firstCol = infoRows.find((row) => Number(row["seqno"]) === 0);
    if (
      firstCol !== undefined &&
      readText(firstCol, "name") === binding.targetIdColumn
    ) {
      return true;
    }
  }
  return false;
}
