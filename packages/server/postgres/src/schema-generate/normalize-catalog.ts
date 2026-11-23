import type {
  CatalogColumn,
  CatalogConstraint,
  CatalogEnum,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CatalogTrigger,
} from "./catalog-types.js";

function compareLexical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCatalogColumns(left: CatalogColumn, right: CatalogColumn): number {
  return left.ordinal - right.ordinal || compareLexical(left.name, right.name);
}

function compareCatalogConstraints(left: CatalogConstraint, right: CatalogConstraint): number {
  return (
    compareLexical(left.name, right.name) ||
    compareLexical(left.kind, right.kind) ||
    compareLexical(left.definition, right.definition)
  );
}

function compareCatalogIndexes(left: CatalogIndex, right: CatalogIndex): number {
  return compareLexical(left.name, right.name) || compareLexical(left.definition, right.definition);
}

function compareCatalogTriggers(left: CatalogTrigger, right: CatalogTrigger): number {
  return compareLexical(left.name, right.name) || compareLexical(left.definition, right.definition);
}

function compareCatalogEnums(left: CatalogEnum, right: CatalogEnum): number {
  return compareLexical(left.schema, right.schema) || compareLexical(left.name, right.name);
}

function compareCatalogTables(left: CatalogTable, right: CatalogTable): number {
  return compareLexical(left.schema, right.schema) || compareLexical(left.name, right.name);
}

function normalizeCatalogTable(table: CatalogTable): CatalogTable {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns.toSorted(compareCatalogColumns),
    constraints: table.constraints.toSorted(compareCatalogConstraints),
    indexes: table.indexes.toSorted(compareCatalogIndexes),
    triggers: table.triggers.toSorted(compareCatalogTriggers),
  };
}

/**
 * Produces a deterministically ordered copy of a catalog snapshot so hashing
 * and code generation never depend on PostgreSQL query scan order.
 */
export function normalizeCatalogSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  const uniqueSchemas = [...new Set(snapshot.schemas)].toSorted(compareLexical);
  const sortedEnums = snapshot.enums
    .map((entry) => ({
      schema: entry.schema,
      name: entry.name,
      labels: [...entry.labels],
    }))
    .toSorted(compareCatalogEnums);
  const sortedTables = snapshot.tables.map(normalizeCatalogTable).toSorted(compareCatalogTables);

  return {
    schemas: uniqueSchemas,
    enums: sortedEnums,
    tables: sortedTables,
  };
}
