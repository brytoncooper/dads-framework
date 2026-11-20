/**
 * Which table holds each `catalog` entity's rows, so the nightly audit can
 * check that a catalog is still as small as its declaration claims.
 *
 * A `catalog` list may still ask SpiceDB for every visible id, because a
 * catalog is bounded by equipment or configuration rather than by daily
 * business. That is a claim about data, and the audit tests it against the
 * data: every catalog names its table here, or says why it has none (a
 * virtual entity keyed by a workspace id, a global singleton).
 */
import { getTableName, type Table } from "drizzle-orm";

import type { EntityHandle } from "@dads-framework/access";

/** A catalog entity and the table its rows live in. */
export type CatalogTable = {
  readonly wireName: string;
  readonly tableName: string;
};

/** A catalog entity with no table of its own, and why. */
export type CatalogWithoutTable = {
  readonly wireName: string;
  readonly reason: string;
};

export type CatalogTableDeclaration = CatalogTable | CatalogWithoutTable;

export function catalogTable(entity: EntityHandle, table: Table): CatalogTable {
  requireCatalog(entity);
  return { wireName: entity.wireName, tableName: getTableName(table) };
}

export function catalogWithoutTable(
  entity: EntityHandle,
  reason: string,
): CatalogWithoutTable {
  requireCatalog(entity);
  if (reason.trim().length === 0) {
    throw new Error(`${entity.wireName} has no table but gives no reason`);
  }
  return { wireName: entity.wireName, reason };
}

export function hasCatalogTable(
  declaration: CatalogTableDeclaration,
): declaration is CatalogTable {
  return "tableName" in declaration;
}

/**
 * Every declared catalog that names no declaration, and every declaration for
 * an entity that is not a declared catalog, as `{ path, message }` failures.
 */
export function catalogTableFailures(
  catalogWireNames: readonly string[],
  declarations: readonly CatalogTableDeclaration[],
): readonly { readonly path: string; readonly message: string }[] {
  const declared = new Set(declarations.map((entry) => entry.wireName));
  const catalogs = new Set(catalogWireNames);
  return [
    ...catalogWireNames
      .filter((wireName) => !declared.has(wireName))
      .map((wireName) => ({
        path: wireName,
        message:
          "is a catalog with no table declared for the nightly size audit; add catalogTable(<entity>, <table>) or catalogWithoutTable(<entity>, <reason>)",
      })),
    ...declarations
      .filter((entry) => !catalogs.has(entry.wireName))
      .map((entry) => ({
        path: entry.wireName,
        message:
          "has a catalog table declaration but is not a registered catalog",
      })),
  ];
}

function requireCatalog(entity: EntityHandle): void {
  if (entity.kind !== "catalog") {
    throw new Error(
      `${entity.wireName} is declared ${entity.kind ?? "with no kind"}, not catalog; only a catalog's table is size-audited`,
    );
  }
}
