import type { CatalogConstraint, CatalogIndex, CatalogTable } from "./catalog-types.js";
import { drizzleForeignKeyAction } from "./render-column.js";
import { escapeSqlTemplate } from "./render-column-default.js";
import type { RelationEntryMetadata, RelationMetadata, TypeImportMetadata } from "./table-metadata.schema.js";

export type TableTargetLookup = {
  readonly exportSymbol: string;
  readonly outputFile: string;
  readonly columnProperty: (columnName: string) => string | undefined;
};

export type TableTargetResolver = (schema: string, tableName: string) => TableTargetLookup | undefined;

export type RenderedTableExtras = {
  readonly entries: readonly string[];
  readonly pgCoreImports: readonly string[];
  readonly usesSql: boolean;
  readonly referencedTables: readonly TableTargetLookup[];
};

export type RenderedRelations = {
  readonly blocks: readonly string[];
  readonly usesRelations: boolean;
  readonly customImports: readonly TypeImportMetadata[];
};

function resolveColumnRefs(
  columns: readonly string[],
  columnMap: ReadonlyMap<string, string>,
  prefix: string,
): readonly string[] | undefined {
  const refs: string[] = [];
  for (const col of columns) {
    const propertyName = columnMap.get(col);
    if (propertyName === undefined) return undefined;
    refs.push(`${prefix}.${propertyName}`);
  }
  return refs;
}

function renderCompositePrimaryKey(
  constraints: readonly CatalogConstraint[],
  columnMap: ReadonlyMap<string, string>,
): { readonly entries: readonly string[]; readonly imports: readonly string[] } {
  const entries: string[] = [];
  const imports: string[] = [];
  for (const constraint of constraints) {
    if (constraint.kind !== "primary_key" || constraint.columns.length < 2) continue;
    const refs = resolveColumnRefs(constraint.columns, columnMap, "table");
    if (refs === undefined) continue;
    imports.push("primaryKey");
    entries.push(`primaryKey({ name: ${JSON.stringify(constraint.name)}, columns: [${refs.join(", ")}] })`);
  }
  return { entries, imports };
}

function renderUniqueConstraints(
  constraints: readonly CatalogConstraint[],
  columnMap: ReadonlyMap<string, string>,
): { readonly entries: readonly string[]; readonly imports: readonly string[]; readonly names: ReadonlySet<string> } {
  const entries: string[] = [];
  const imports: string[] = [];
  const names = new Set<string>();
  for (const constraint of constraints) {
    if (constraint.kind !== "unique") continue;
    const refs = resolveColumnRefs(constraint.columns, columnMap, "table");
    if (refs === undefined) continue;
    imports.push("unique");
    names.add(constraint.name);
    entries.push(`unique(${JSON.stringify(constraint.name)}).on(${refs.join(", ")})`);
  }
  return { entries, imports, names };
}

function appendForeignKeyActions(expr: string, constraint: CatalogConstraint): string {
  let result = expr;
  if (constraint.onDelete !== null && constraint.onDelete !== "no_action") {
    result += `.onDelete(${JSON.stringify(drizzleForeignKeyAction(constraint.onDelete))})`;
  }
  if (constraint.onUpdate !== null && constraint.onUpdate !== "no_action") {
    result += `.onUpdate(${JSON.stringify(drizzleForeignKeyAction(constraint.onUpdate))})`;
  }
  return result;
}

function resolveForeignColumnRefs(
  columns: readonly string[],
  target: TableTargetLookup,
): readonly string[] | undefined {
  const refs: string[] = [];
  for (const col of columns) {
    const prop = target.columnProperty(col);
    if (prop === undefined) return undefined;
    refs.push(`${target.exportSymbol}.${prop}`);
  }
  return refs;
}

function renderCompositeForeignKeyItem(
  constraint: CatalogConstraint,
  columnMap: ReadonlyMap<string, string>,
  resolveTarget: TableTargetResolver,
): { readonly entry: string; readonly target: TableTargetLookup } | undefined {
  if (constraint.referencedSchema === null || constraint.referencedTable === null) return undefined;
  const target = resolveTarget(constraint.referencedSchema, constraint.referencedTable);
  if (target === undefined) return undefined;
  const localRefs = resolveColumnRefs(constraint.columns, columnMap, "table");
  const foreignRefs = resolveForeignColumnRefs(constraint.referencedColumns, target);
  if (localRefs === undefined || foreignRefs === undefined) return undefined;
  const baseExpr =
    `foreignKey({ name: ${JSON.stringify(constraint.name)}, ` +
    `columns: [${localRefs.join(", ")}], foreignColumns: [${foreignRefs.join(", ")}] })`;
  return { entry: appendForeignKeyActions(baseExpr, constraint), target };
}

function renderCompositeForeignKeys(
  constraints: readonly CatalogConstraint[],
  columnMap: ReadonlyMap<string, string>,
  resolveTarget: TableTargetResolver,
): {
  readonly entries: readonly string[];
  readonly imports: readonly string[];
  readonly targets: readonly TableTargetLookup[];
} {
  const entries: string[] = [];
  const imports: string[] = [];
  const targets: TableTargetLookup[] = [];
  for (const constraint of constraints) {
    if (constraint.kind !== "foreign_key" || constraint.columns.length < 2) continue;
    const rendered = renderCompositeForeignKeyItem(constraint, columnMap, resolveTarget);
    if (rendered === undefined) continue;
    imports.push("foreignKey");
    entries.push(rendered.entry);
    targets.push(rendered.target);
  }
  return { entries, imports, targets };
}

function renderIndexKeyExpression(
  rawExpr: string,
  columnMap: ReadonlyMap<string, string>,
): { readonly code: string; readonly usesSql: boolean } {
  const unquoted = /^"([^"]+)"$/.exec(rawExpr.trim())?.[1] ?? rawExpr.trim();
  const propertyName = columnMap.get(unquoted);
  if (propertyName !== undefined) {
    return { code: `table.${propertyName}`, usesSql: false };
  }
  return { code: `sql\`${escapeSqlTemplate(rawExpr.trim())}\``, usesSql: true };
}

function renderSingleIndex(
  idx: CatalogIndex,
  columnMap: ReadonlyMap<string, string>,
  retiredColumns: ReadonlySet<string>,
): { readonly entry: string; readonly importName: string; readonly usesSql: boolean } | undefined {
  if (idx.columns.some((col) => retiredColumns.has(col))) return undefined;
  const keySources = idx.expressions.length > 0 ? idx.expressions : idx.columns;
  if (keySources.length === 0) return undefined;

  let usesSql = false;
  const keyCodes = keySources.map((expr) => {
    const rendered = renderIndexKeyExpression(expr, columnMap);
    if (rendered.usesSql) usesSql = true;
    return rendered.code;
  });

  const builderName = idx.isUnique ? "uniqueIndex" : "index";
  const methodClause =
    idx.accessMethod !== "btree"
      ? `.using(${JSON.stringify(idx.accessMethod)}, ${keyCodes.join(", ")})`
      : `.on(${keyCodes.join(", ")})`;
  let expr = `${builderName}(${JSON.stringify(idx.name)})${methodClause}`;
  if (idx.wherePredicate !== null) {
    usesSql = true;
    expr += `.where(sql\`${escapeSqlTemplate(idx.wherePredicate)}\`)`;
  }
  return { entry: expr, importName: builderName, usesSql };
}

function renderTableIndexes(
  indexes: readonly CatalogIndex[],
  columnMap: ReadonlyMap<string, string>,
  uniqueConstraintNames: ReadonlySet<string>,
  retiredColumns: ReadonlySet<string>,
): { readonly entries: readonly string[]; readonly imports: readonly string[]; readonly usesSql: boolean } {
  const entries: string[] = [];
  const imports: string[] = [];
  let usesSql = false;
  for (const idx of indexes) {
    if (idx.isPrimary || uniqueConstraintNames.has(idx.name)) continue;
    const rendered = renderSingleIndex(idx, columnMap, retiredColumns);
    if (rendered === undefined) continue;
    entries.push(rendered.entry);
    imports.push(rendered.importName);
    if (rendered.usesSql) usesSql = true;
  }
  return { entries, imports, usesSql };
}

function renderCheckConstraints(constraints: readonly CatalogConstraint[]): {
  readonly entries: readonly string[];
  readonly imports: readonly string[];
  readonly usesSql: boolean;
} {
  const entries: string[] = [];
  const imports: string[] = [];
  let usesSql = false;
  for (const constraint of constraints) {
    if (constraint.kind !== "check" || constraint.checkExpression === null) continue;
    imports.push("check");
    usesSql = true;
    entries.push(`check(${JSON.stringify(constraint.name)}, sql\`${escapeSqlTemplate(constraint.checkExpression)}\`)`);
  }
  return { entries, imports, usesSql };
}

/** Renders table-level constraints and indexes for Drizzle's `(table) => [...]` block. */
export function renderTableExtras(
  table: CatalogTable,
  columnMap: ReadonlyMap<string, string>,
  retiredColumns: ReadonlySet<string>,
  resolveTarget: TableTargetResolver,
): RenderedTableExtras {
  const pks = renderCompositePrimaryKey(table.constraints, columnMap);
  const uniques = renderUniqueConstraints(table.constraints, columnMap);
  const fks = renderCompositeForeignKeys(table.constraints, columnMap, resolveTarget);
  const indexes = renderTableIndexes(table.indexes, columnMap, uniques.names, retiredColumns);
  const checks = renderCheckConstraints(table.constraints);

  return {
    entries: [...pks.entries, ...uniques.entries, ...fks.entries, ...indexes.entries, ...checks.entries],
    pgCoreImports: [...pks.imports, ...uniques.imports, ...fks.imports, ...indexes.imports, ...checks.imports],
    usesSql: indexes.usesSql || checks.usesSql,
    referencedTables: fks.targets,
  };
}

function formatRelationEntry(tableExportSymbol: string, entry: RelationEntryMetadata): string {
  const options: string[] = [];
  if (entry.fields !== undefined && entry.fields.length > 0) {
    options.push(`fields: [${entry.fields.map((field) => `${tableExportSymbol}.${field}`).join(", ")}]`);
  }
  if (entry.references !== undefined && entry.references.length > 0) {
    options.push(`references: [${entry.references.map((ref) => `${entry.targetSymbol}.${ref}`).join(", ")}]`);
  }
  if (entry.relationName !== undefined) {
    options.push(`relationName: ${JSON.stringify(entry.relationName)}`);
  }
  const configArg = options.length > 0 ? `, { ${options.join(", ")} }` : "";
  return `  ${entry.propertyName}: ${entry.kind}(${entry.targetSymbol}${configArg}),`;
}

/** Renders optional Drizzle `relations(...)` exports declared in table metadata. */
export function renderTableRelations(
  tableExportSymbol: string,
  relationDefs: readonly RelationMetadata[] | undefined,
): RenderedRelations {
  if (relationDefs === undefined || relationDefs.length === 0) {
    return { blocks: [], usesRelations: false, customImports: [] };
  }
  const blocks: string[] = [];
  const customImports: TypeImportMetadata[] = [];
  for (const rel of relationDefs) {
    const helpers = [...new Set(rel.entries.map((entry) => entry.kind))].toSorted();
    const bodyLines = rel.entries.map((entry) => formatRelationEntry(tableExportSymbol, entry));
    for (const entry of rel.entries) {
      if (entry.targetImport !== undefined) {
        customImports.push({ from: entry.targetImport, names: [entry.targetSymbol], typeOnly: false });
      }
    }
    blocks.push(
      `export const ${rel.exportSymbol} = relations(${tableExportSymbol}, ({ ${helpers.join(", ")} }) => ({\n` +
        `${bodyLines.join("\n")}\n` +
        `}));`,
    );
  }
  return { blocks, usesRelations: true, customImports };
}
