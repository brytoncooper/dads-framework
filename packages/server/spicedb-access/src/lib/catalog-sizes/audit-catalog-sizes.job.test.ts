/**
 * What/why: a `catalog` may be listed from every visible id only because it
 * stays small, so the nightly audit checks each declaration against Postgres's
 * row estimate and reports every catalog past the mark by name. A catalog
 * without its own table, or one Postgres has not sized yet, is never reported
 * as oversized; the boot check refuses a catalog that declared neither.
 */
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { resource } from "@dads-framework/access";

import type { CatalogOverSizeMarkError } from "./audit-catalog-sizes.job.js";
import { auditCatalogSizes, createAuditCatalogSizesJob } from "./audit-catalog-sizes.job.js";
import { CatalogSizeReader } from "./catalog-size-reader.js";
import { catalogTable, catalogTableFailures, catalogWithoutTable } from "./catalog-tables.js";

const idSchema = z.string();
const Machine = resource("test/machine", { id: idSchema });
const Recipe = resource("test/recipe", { id: idSchema });
const Library = resource("test/library", { id: idSchema });
const Ticket = resource("test/ticket", { id: idSchema });

const machines = pgTable("test_machines", { id: text("id").primaryKey() });
const recipes = pgTable("test_recipes", { id: text("id").primaryKey() });

class FakeCatalogSizeReader extends CatalogSizeReader {
  constructor(private readonly estimates: Readonly<Record<string, number>>) {
    super();
  }
  override estimatedRows(tableNames: readonly string[]) {
    return Promise.resolve(
      new Map(
        tableNames.flatMap((name) => {
          const estimate = this.estimates[name];
          return estimate === undefined ? [] : [[name, estimate] as const];
        }),
      ),
    );
  }
}

const silent = { info: () => undefined, error: () => undefined };

const declarations = [
  catalogTable(Machine, machines),
  catalogTable(Recipe, recipes),
  catalogWithoutTable(Library, "one per workspace, keyed by the workspace id"),
];

describe("auditCatalogSizes", () => {
  it("reports every catalog table estimated past the mark, by name", async () => {
    const oversized = await auditCatalogSizes({
      catalogTables: declarations,
      reader: new FakeCatalogSizeReader({
        test_machines: 5_001,
        test_recipes: 5_000,
      }),
      warnRows: 5_000,
      log: silent,
    });
    expect(oversized).toEqual([
      {
        wireName: "test/machine",
        tableName: "test_machines",
        estimatedRows: 5_001,
        warnRows: 5_000,
      },
    ]);
  });

  it("does not report a table Postgres has not sized", async () => {
    await expect(
      auditCatalogSizes({
        catalogTables: declarations,
        reader: new FakeCatalogSizeReader({}),
        warnRows: 5_000,
        log: silent,
      }),
    ).resolves.toEqual([]);
  });

  it("reports each oversized catalog as a fault from the scheduled job", async () => {
    const reported: CatalogOverSizeMarkError[] = [];
    const job = createAuditCatalogSizesJob({
      catalogTables: declarations,
      reader: new FakeCatalogSizeReader({ test_machines: 12_000 }),
      warnRows: 5_000,
      reportFault: (error) => reported.push(error),
      log: silent,
    });
    expect(job.name).toBe("authorization.audit-catalog-sizes");
    await job.run({});
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain(
      "test/machine is declared a catalog but test_machines holds about 12000 rows, past the 5000 mark",
    );
  });
});

describe("catalog table declarations", () => {
  it("refuses a catalogWithoutTable with an empty reason and flags stray declarations", () => {
    expect(() => catalogWithoutTable(Ticket, "   ")).toThrow("test/ticket has no table but gives no reason");
    expect(
      catalogTableFailures(["test/machine"], [catalogTable(Machine, machines), catalogTable(Ticket, machines)]),
    ).toEqual([
      {
        path: "test/ticket",
        message: "has a catalog table declaration but is not a registered catalog",
      },
    ]);
  });

  it("names every catalog without a declaration and every stray declaration", () => {
    expect(catalogTableFailures(["test/machine", "test/scale"], declarations)).toEqual([
      {
        path: "test/scale",
        message:
          "is a catalog with no table declared for the nightly size audit; add catalogTable(<entity>, <table>) or catalogWithoutTable(<entity>, <reason>)",
      },
      {
        path: "test/recipe",
        message: "has a catalog table declaration but is not a registered catalog",
      },
      {
        path: "test/library",
        message: "has a catalog table declaration but is not a registered catalog",
      },
    ]);
  });
});
