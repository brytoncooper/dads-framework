import { createHash } from "node:crypto";
import type { CatalogSnapshot, CatalogTable } from "./catalog-types.js";
import { normalizeCatalogSnapshot } from "./normalize-catalog.js";

/** Canonical lookup key for a table within a `CatalogSnapshot`. */
export function tableSchemaKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

/**
 * Computes a deterministic 16-hex-char SHA-256 fingerprint covering a table's
 * full columns, constraints, indexes, and triggers.
 */
export function computeTableSchemaFingerprint(table: CatalogTable): string {
  const normalized = normalizeCatalogSnapshot({
    schemas: [table.schema],
    enums: [],
    tables: [table],
  });
  const canonicalTable = normalized.tables[0] ?? table;
  const payload = JSON.stringify({
    schema: canonicalTable.schema,
    name: canonicalTable.name,
    columns: canonicalTable.columns,
    constraints: canonicalTable.constraints,
    indexes: canonicalTable.indexes,
    triggers: canonicalTable.triggers,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Computes deterministic 16-hex-char SHA-256 fingerprints for every table in a
 * catalog snapshot, keyed by `${table.schema}.${table.name}`. Fingerprints
 * always cover the full catalog table including any columns omitted from output.
 */
export function tableSchemaFingerprints(catalog: CatalogSnapshot): ReadonlyMap<string, string> {
  const normalized = normalizeCatalogSnapshot(catalog);
  const fingerprints = new Map<string, string>();
  for (const table of normalized.tables) {
    fingerprints.set(tableSchemaKey(table.schema, table.name), computeTableSchemaFingerprint(table));
  }
  return fingerprints;
}
