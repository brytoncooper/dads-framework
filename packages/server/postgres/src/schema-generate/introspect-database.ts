import { z } from "zod";
import type {
  CatalogColumn,
  CatalogConstraint,
  CatalogConstraintKind,
  CatalogEnum,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CatalogTrigger,
  ForeignKeyAction,
} from "./catalog-types.js";
import {
  SELECT_COLUMNS_SQL,
  SELECT_CONSTRAINTS_SQL,
  SELECT_ENUMS_SQL,
  SELECT_FILTERED_SCHEMAS_SQL,
  SELECT_INDEXES_SQL,
  SELECT_TABLES_SQL,
  SELECT_TRIGGERS_SQL,
  SELECT_USER_SCHEMAS_SQL,
} from "./introspect-catalog-queries.js";
import { normalizeCatalogSnapshot } from "./normalize-catalog.js";

/** Minimal queryable PostgreSQL session or pool surface used for catalog reads. */
export type CatalogQueryClient = {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
};

const DEFAULT_EXCLUDED_TABLES: readonly string[] = [
  "pgmigrations",
  "dads_migrations",
  "dads_migration_checksums",
  "__drizzle_migrations",
];

export type IntrospectPostgresCatalogOptions = {
  /** Restrict introspection to these schemas. Defaults to all non-system schemas. */
  readonly schemas?: readonly string[];
  /** Additional table names to exclude alongside migration journal tables. */
  readonly excludeTables?: readonly string[];
};

const schemaRowSchema = z.object({ schema_name: z.string() });
const enumRowSchema = z.object({
  schema_name: z.string(),
  enum_name: z.string(),
  labels: z.array(z.string()),
});
const tableRowSchema = z.object({ schema_name: z.string(), table_name: z.string() });
const columnRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  column_name: z.string(),
  ordinal: z.coerce.number().int(),
  formatted_type: z.string(),
  udt_schema: z.string(),
  udt_name: z.string(),
  is_nullable: z.boolean(),
  default_expression: z.string().nullable(),
  identity_generation: z.string(),
  generated_kind: z.string(),
  generated_expression: z.string().nullable(),
  array_dimensions: z.coerce.number().int(),
});
const constraintRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  constraint_name: z.string(),
  constraint_type: z.string(),
  definition: z.string(),
  columns: z.array(z.string()),
  referenced_schema: z.string().nullable(),
  referenced_table: z.string().nullable(),
  referenced_columns: z.array(z.string()),
  on_update: z.string().nullable(),
  on_delete: z.string().nullable(),
});
const indexRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  index_name: z.string(),
  is_unique: z.boolean(),
  is_primary: z.boolean(),
  access_method: z.string(),
  definition: z.string(),
  key_columns: z.array(z.string()),
  key_expressions: z.array(z.string()),
  where_predicate: z.string().nullable(),
});
const triggerRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  trigger_name: z.string(),
  definition: z.string(),
  is_internal: z.boolean(),
});

function parseCatalogRows<T>(schema: z.ZodType<T>, rows: readonly unknown[]): readonly T[] {
  return rows.map((row) => schema.parse(row));
}

function mapConstraintKind(code: string): CatalogConstraintKind {
  switch (code) {
    case "p":
      return "primary_key";
    case "f":
      return "foreign_key";
    case "u":
      return "unique";
    case "c":
      return "check";
    default:
      throw new Error(`Unsupported PostgreSQL constraint type code: ${code}`);
  }
}

function mapForeignKeyAction(code: string | null): ForeignKeyAction | null {
  switch (code) {
    case null:
    case "":
    case " ":
      return null;
    case "a":
      return "no_action";
    case "r":
      return "restrict";
    case "c":
      return "cascade";
    case "n":
      return "set_null";
    case "d":
      return "set_default";
    default:
      throw new Error(`Unsupported PostgreSQL foreign key action code: ${code}`);
  }
}

function extractCheckExpression(kind: CatalogConstraintKind, definition: string): string | null {
  if (kind !== "check") return null;
  const trimmed = definition.trim();
  const match = /^CHECK\s*\(([\s\S]*)\)$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function mapIdentityGeneration(code: string): "a" | "d" | null {
  if (code === "a" || code === "d") return code;
  return null;
}

function catalogTableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function appendGroupedEntry<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const existing = groups.get(key);
  if (existing !== undefined) {
    existing.push(value);
    return;
  }
  groups.set(key, [value]);
}

async function queryIntrospectedSchemas(
  client: CatalogQueryClient,
  requestedSchemas?: readonly string[],
): Promise<readonly string[]> {
  const result =
    requestedSchemas !== undefined
      ? await client.query(SELECT_FILTERED_SCHEMAS_SQL, [[...requestedSchemas]])
      : await client.query(SELECT_USER_SCHEMAS_SQL);
  return parseCatalogRows(schemaRowSchema, result.rows).map((row) => row.schema_name);
}

async function queryIntrospectedEnums(
  client: CatalogQueryClient,
  schemas: readonly string[],
): Promise<readonly CatalogEnum[]> {
  const result = await client.query(SELECT_ENUMS_SQL, [[...schemas]]);
  return parseCatalogRows(enumRowSchema, result.rows).map((row) => ({
    schema: row.schema_name,
    name: row.enum_name,
    labels: row.labels,
  }));
}

async function queryIntrospectedTables(
  client: CatalogQueryClient,
  schemas: readonly string[],
  excludedTables: readonly string[],
): Promise<readonly { readonly schema: string; readonly name: string }[]> {
  const result = await client.query(SELECT_TABLES_SQL, [[...schemas], [...excludedTables]]);
  return parseCatalogRows(tableRowSchema, result.rows).map((row) => ({
    schema: row.schema_name,
    name: row.table_name,
  }));
}

async function queryIntrospectedColumns(
  client: CatalogQueryClient,
  schemas: readonly string[],
  excludedTables: readonly string[],
): Promise<ReadonlyMap<string, readonly CatalogColumn[]>> {
  const result = await client.query(SELECT_COLUMNS_SQL, [[...schemas], [...excludedTables]]);
  const grouped = new Map<string, CatalogColumn[]>();
  for (const row of parseCatalogRows(columnRowSchema, result.rows)) {
    const identityGeneration = mapIdentityGeneration(row.identity_generation);
    appendGroupedEntry(grouped, catalogTableKey(row.schema_name, row.table_name), {
      name: row.column_name,
      ordinal: row.ordinal,
      formattedType: row.formatted_type,
      udtSchema: row.udt_schema,
      udtName: row.udt_name,
      isNullable: row.is_nullable,
      defaultExpression: row.default_expression,
      isIdentity: identityGeneration !== null,
      identityGeneration,
      isGenerated: row.generated_kind !== "",
      generatedExpression: row.generated_expression,
      arrayDimensions: row.array_dimensions,
    });
  }
  return grouped;
}

async function queryIntrospectedConstraints(
  client: CatalogQueryClient,
  schemas: readonly string[],
  excludedTables: readonly string[],
): Promise<ReadonlyMap<string, readonly CatalogConstraint[]>> {
  const result = await client.query(SELECT_CONSTRAINTS_SQL, [[...schemas], [...excludedTables]]);
  const grouped = new Map<string, CatalogConstraint[]>();
  for (const row of parseCatalogRows(constraintRowSchema, result.rows)) {
    const kind = mapConstraintKind(row.constraint_type);
    appendGroupedEntry(grouped, catalogTableKey(row.schema_name, row.table_name), {
      name: row.constraint_name,
      kind,
      definition: row.definition,
      columns: row.columns,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns,
      onUpdate: kind === "foreign_key" ? mapForeignKeyAction(row.on_update) : null,
      onDelete: kind === "foreign_key" ? mapForeignKeyAction(row.on_delete) : null,
      checkExpression: extractCheckExpression(kind, row.definition),
    });
  }
  return grouped;
}

async function queryIntrospectedIndexes(
  client: CatalogQueryClient,
  schemas: readonly string[],
  excludedTables: readonly string[],
): Promise<ReadonlyMap<string, readonly CatalogIndex[]>> {
  const result = await client.query(SELECT_INDEXES_SQL, [[...schemas], [...excludedTables]]);
  const grouped = new Map<string, CatalogIndex[]>();
  for (const row of parseCatalogRows(indexRowSchema, result.rows)) {
    appendGroupedEntry(grouped, catalogTableKey(row.schema_name, row.table_name), {
      name: row.index_name,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      accessMethod: row.access_method,
      definition: row.definition,
      columns: row.key_columns.filter((col) => col.length > 0),
      expressions: row.key_expressions,
      wherePredicate: row.where_predicate,
    });
  }
  return grouped;
}

async function queryIntrospectedTriggers(
  client: CatalogQueryClient,
  schemas: readonly string[],
  excludedTables: readonly string[],
): Promise<ReadonlyMap<string, readonly CatalogTrigger[]>> {
  const result = await client.query(SELECT_TRIGGERS_SQL, [[...schemas], [...excludedTables]]);
  const grouped = new Map<string, CatalogTrigger[]>();
  for (const row of parseCatalogRows(triggerRowSchema, result.rows)) {
    appendGroupedEntry(grouped, catalogTableKey(row.schema_name, row.table_name), {
      name: row.trigger_name,
      definition: row.definition,
      isInternal: row.is_internal,
    });
  }
  return grouped;
}

/**
 * Reads tables, columns, constraints, indexes, triggers, and enums from
 * PostgreSQL's `pg_catalog` and returns a deterministically normalized snapshot.
 */
export async function introspectPostgresCatalog(
  client: CatalogQueryClient,
  options?: IntrospectPostgresCatalogOptions,
): Promise<CatalogSnapshot> {
  const schemas = await queryIntrospectedSchemas(client, options?.schemas);
  if (schemas.length === 0) {
    return { schemas: [], enums: [], tables: [] };
  }
  const excludedTables = [...new Set([...DEFAULT_EXCLUDED_TABLES, ...(options?.excludeTables ?? [])])];
  const [enums, rawTables, columnsByTable, constraintsByTable, indexesByTable, triggersByTable] = await Promise.all([
    queryIntrospectedEnums(client, schemas),
    queryIntrospectedTables(client, schemas, excludedTables),
    queryIntrospectedColumns(client, schemas, excludedTables),
    queryIntrospectedConstraints(client, schemas, excludedTables),
    queryIntrospectedIndexes(client, schemas, excludedTables),
    queryIntrospectedTriggers(client, schemas, excludedTables),
  ]);

  const tables: CatalogTable[] = rawTables.map((entry) => {
    const key = catalogTableKey(entry.schema, entry.name);
    return {
      schema: entry.schema,
      name: entry.name,
      columns: columnsByTable.get(key) ?? [],
      constraints: constraintsByTable.get(key) ?? [],
      indexes: indexesByTable.get(key) ?? [],
      triggers: triggersByTable.get(key) ?? [],
    };
  });

  return normalizeCatalogSnapshot({ schemas, enums, tables });
}
