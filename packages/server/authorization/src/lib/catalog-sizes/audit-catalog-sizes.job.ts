import { z } from "zod";

import {
  cronSchedule,
  defineJob,
  type JobDefinition,
  type JobLog,
} from "@dads-framework/job-queue-core";

import type { CatalogSizeReader } from "./catalog-size-reader.js";
import {
  type CatalogTable,
  type CatalogTableDeclaration,
  hasCatalogTable,
} from "./catalog-tables.js";

export const AUDIT_CATALOG_SIZES_JOB = "authorization.audit-catalog-sizes";

/** One catalog table estimated past the mark. */
export type OversizedCatalog = {
  readonly wireName: string;
  readonly tableName: string;
  readonly estimatedRows: number;
  readonly warnRows: number;
};

/** A catalog estimated past the mark, as the fault this job reports. */
export class CatalogOverSizeMarkError extends Error {
  constructor(catalog: OversizedCatalog) {
    super(
      `${catalog.wireName} is declared a catalog but ${catalog.tableName} holds about ${catalog.estimatedRows} rows, ` +
        `past the ${catalog.warnRows} mark (AUTHZ_CATALOG_SIZE_WARN); if it grows with business activity it is a record, ` +
        `and its lists must move onto requiresScoped`,
    );
    this.name = "CatalogOverSizeMarkError";
  }
}

export type CreateAuditCatalogSizesJobDeps = {
  readonly catalogTables: readonly CatalogTableDeclaration[];
  readonly reader: CatalogSizeReader;
  /** A catalog table estimated past this many rows is reported. */
  readonly warnRows: number;
  /** Where an oversized catalog is reported; the composition root binds diagnostics. */
  readonly reportFault: (error: CatalogOverSizeMarkError) => void;
  readonly log: JobLog;
};

/**
 * Once a day, checks every `catalog` declaration against the data.
 *
 * A catalog list may ask SpiceDB for every visible id because a catalog is
 * supposed to stay small. Nobody has to trust that: this reads Postgres's row
 * estimate for each catalog's table and reports, by name, every one past the
 * mark. A catalog that is really a record shows up here months before its
 * list would trip the lookup guards on a single caller.
 *
 * Reads only `pg_class` (no scan, no lock beyond the catalog's own), and
 * reports rather than throws: an oversized catalog is a finding, not a failed
 * job to retry.
 */
export function createAuditCatalogSizesJob(
  deps: CreateAuditCatalogSizesJobDeps,
): JobDefinition {
  if (!Number.isInteger(deps.warnRows) || deps.warnRows <= 0) {
    throw new Error(
      `catalog size warnRows must be a positive integer, got ${deps.warnRows}`,
    );
  }
  return defineJob({
    name: AUDIT_CATALOG_SIZES_JOB,
    payload: z.strictObject({}),
    retry: { attempts: 3, backoffMs: 5_000 },
    schedules: [
      cronSchedule({
        id: "authorization.audit-catalog-sizes.daily",
        pattern: "0 30 4 * * *",
        timeZone: "UTC",
        payload: {},
      }),
    ],
    run: async () => {
      const oversized = await auditCatalogSizes(deps);
      for (const catalog of oversized) {
        deps.reportFault(new CatalogOverSizeMarkError(catalog));
        deps.log.error(
          { event: "authorization.catalog-over-size-mark", ...catalog },
          "a catalog table is past its size mark",
        );
      }
    },
  });
}

/** Every declared catalog table whose estimate is past the mark. */
export async function auditCatalogSizes(
  deps: Pick<
    CreateAuditCatalogSizesJobDeps,
    "catalogTables" | "reader" | "warnRows" | "log"
  >,
): Promise<readonly OversizedCatalog[]> {
  const tables: readonly CatalogTable[] =
    deps.catalogTables.filter(hasCatalogTable);
  const estimates = await deps.reader.estimatedRows(
    tables.map((table) => table.tableName),
  );
  const unsized = tables
    .filter((table) => !estimates.has(table.tableName))
    .map((table) => table.tableName);
  deps.log.info(
    {
      event: "authorization.catalog-sizes-audited",
      audited: tables.length - unsized.length,
      unsized,
      warnRows: deps.warnRows,
    },
    "catalog table sizes audited",
  );
  return tables.flatMap((table) => {
    const estimatedRows = estimates.get(table.tableName);
    return estimatedRows !== undefined && estimatedRows > deps.warnRows
      ? [
          {
            wireName: table.wireName,
            tableName: table.tableName,
            estimatedRows,
            warnRows: deps.warnRows,
          },
        ]
      : [];
  });
}
