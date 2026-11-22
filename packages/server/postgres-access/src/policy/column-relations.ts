import type { RoleToken } from "@dads-framework/access";
import type { PostgresQuery, PostgresRow } from "../postgres-types.js";
import type {
  AuthorizationModelDefinition,
  CompiledColumnRelation,
} from "./policy-model.js";

const SQL_COLUMN_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SQL_TABLE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

/** Public binding declaring that a single-target FK relation lives directly on an application table. */
export type ColumnRelationBinding = {
  readonly role: RoleToken;
  /** Table name (`documents` or `public.documents`). */
  readonly table: string;
  /** Primary key column storing the resource ID (e.g. `"id"`). */
  readonly idColumn: string;
  /** Foreign-key column storing the target ID (e.g. `"org_id"`, `"parent_id"`, or `"owner_id"`). */
  readonly targetIdColumn: string;
};

/** Verification status for one column-backed relation against the live database schema. */
export type ColumnRelationCheckResult = {
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
      `Invalid columnRelation ${label} "${value}": must be an unquoted SQL identifier`,
    );
  }
}

function splitSchemaTable(qualifiedTable: string): {
  readonly schema: string;
  readonly table: string;
} {
  const dotIndex = qualifiedTable.indexOf(".");
  if (dotIndex === -1) {
    return { schema: "public", table: qualifiedTable };
  }
  return {
    schema: qualifiedTable.slice(0, dotIndex),
    table: qualifiedTable.slice(dotIndex + 1),
  };
}

/** Validate and attach `columnRelations` bindings against the lowered policy model. */
export function compileColumnRelations(
  model: AuthorizationModelDefinition,
  bindings: readonly ColumnRelationBinding[] | undefined,
): readonly CompiledColumnRelation[] {
  if (bindings === undefined || bindings.length === 0) return [];
  const seen = new Set<string>();
  const compiled: CompiledColumnRelation[] = [];
  for (const binding of bindings) {
    compiled.push(compileSingleColumnRelation(model, binding, seen));
  }
  return Object.freeze(compiled);
}

function compileSingleColumnRelation(
  model: AuthorizationModelDefinition,
  binding: ColumnRelationBinding,
  seen: Set<string>,
): CompiledColumnRelation {
  const entity = binding.role.entityWireName;
  const relation = binding.role.roleName;
  const key = `${entity}\u0000${relation}`;
  if (seen.has(key)) {
    throw new Error(
      `Duplicate columnRelation binding for ${entity}#${relation}`,
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
      `Column relation ${entity}#${relation} does not exist in the compiled access model`,
    );
  }
  const onlyTarget =
    relDef.targets.length === 1 ? relDef.targets[0] : undefined;
  if (onlyTarget === undefined || onlyTarget.kind !== "entity") {
    throw new Error(
      `Column relation ${entity}#${relation} must declare exactly one direct entity target (no polymorphic, wildcard, or userset targets)`,
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
export function findColumnRelation(
  model: AuthorizationModelDefinition,
  entity: string,
  relation: string,
): CompiledColumnRelation | undefined {
  return model.columnRelations?.find(
    (entry) => entry.entity === entity && entry.relation === relation,
  );
}

/** Generate recommended `(targetIdColumn, idColumn)` reverse-lookup index DDL for column-backed relations. */
export function columnRelationIndexSql(
  bindings: readonly ColumnRelationBinding[],
): readonly string[] {
  return bindings.map((binding) => {
    assertSafeIdentifier(binding.table, SQL_TABLE_IDENT, "table");
    assertSafeIdentifier(binding.idColumn, SQL_COLUMN_IDENT, "idColumn");
    assertSafeIdentifier(
      binding.targetIdColumn,
      SQL_COLUMN_IDENT,
      "targetIdColumn",
    );
    const { table } = splitSchemaTable(binding.table);
    const indexName = `idx_dad_${table}_${binding.targetIdColumn}_${binding.idColumn}`;
    return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${binding.table} (${binding.targetIdColumn}, ${binding.idColumn});`;
  });
}

/** Auto-derive `scopeColumns` from `columnRelations` on `resourceType` matching `idColumn`'s table prefix. */
export function deriveAutoScopeColumns(
  model: AuthorizationModelDefinition,
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

function readTextCell(row: PostgresRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

/** Verify every column-backed table and column exists in PostgreSQL and report index status. */
export async function verifyPostgresColumnRelations(
  relations: readonly CompiledColumnRelation[],
  runQuery: (query: PostgresQuery) => Promise<readonly PostgresRow[]>,
): Promise<readonly ColumnRelationCheckResult[]> {
  const results: ColumnRelationCheckResult[] = [];
  for (const binding of relations) {
    results.push(await verifyOneColumnRelation(binding, runQuery));
  }
  return results;
}

async function verifyOneColumnRelation(
  binding: CompiledColumnRelation,
  runQuery: (query: PostgresQuery) => Promise<readonly PostgresRow[]>,
): Promise<ColumnRelationCheckResult> {
  const { schema, table } = splitSchemaTable(binding.table);
  const colRows = await runQuery({
    text: `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name IN ($3, $4)`,
    values: [schema, table, binding.idColumn, binding.targetIdColumn],
  });
  const present = new Set(
    colRows.map((row) => readTextCell(row, "column_name")),
  );
  for (const required of [binding.idColumn, binding.targetIdColumn]) {
    if (!present.has(required)) {
      throw new Error(
        `Column relation ${binding.entity}#${binding.relation} expects column "${binding.table}.${required}", which does not exist in PostgreSQL`,
      );
    }
  }
  const indexRows = await runQuery({
    text: `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
    values: [schema, table],
  });
  const targetPrefix = `(${binding.targetIdColumn}`;
  const hasRecommendedIndex = indexRows.some((row) =>
    readTextCell(row, "indexdef").includes(targetPrefix),
  );
  const indexName = `idx_dad_${table}_${binding.targetIdColumn}_${binding.idColumn}`;
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
