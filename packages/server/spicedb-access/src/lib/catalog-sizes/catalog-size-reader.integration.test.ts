/**
 * What/why: the nightly catalog audit trusts Postgres's own row estimate, so
 * this seeds a real table past the mark, lets ANALYZE size it, and checks the
 * reader reports that estimate and the audit names the catalog. A table that
 * was never analyzed stays unsized rather than reading as empty.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { resource } from "@dads-framework/access";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres, type TestPostgres } from "@dads-framework/postgres/testing";

import { auditCatalogSizes } from "./audit-catalog-sizes.job.js";
import { PostgresCatalogSizeReader } from "./catalog-size-reader.js";
import { catalogTable } from "./catalog-tables.js";

const idSchema = z.string();
const Machine = resource("sizeaudit/machine", { id: idSchema });
const Recipe = resource("sizeaudit/recipe", { id: idSchema });
const machines = pgTable("size_audit_machines", {
  id: text("id").primaryKey(),
});
const recipes = pgTable("size_audit_recipes", { id: text("id").primaryKey() });

const silent = { info: () => undefined, error: () => undefined };

describe("PostgresCatalogSizeReader (integration)", () => {
  let postgres: TestPostgres;
  let db: DrizzleHandle;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres({ attributed: false });
    db = drizzle(postgres.pool);
    await db.execute(sql`CREATE TABLE size_audit_machines (id text PRIMARY KEY)`);
    await db.execute(sql`CREATE TABLE size_audit_recipes (id text PRIMARY KEY)`);
    await db.execute(sql`INSERT INTO size_audit_machines SELECT 'm-' || n FROM generate_series(1, 1200) AS n`);
    await db.execute(sql`ANALYZE size_audit_machines`);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("reads the analyzed estimate and leaves an unanalyzed table unsized", async () => {
    const estimates = await new PostgresCatalogSizeReader(db).estimatedRows([
      "size_audit_machines",
      "size_audit_recipes",
      "size_audit_missing",
    ]);
    expect(estimates.get("size_audit_machines")).toBe(1200);
    expect(estimates.has("size_audit_recipes")).toBe(false);
    expect(estimates.has("size_audit_missing")).toBe(false);
  });

  it("names the seeded catalog past the mark", async () => {
    const oversized = await auditCatalogSizes({
      catalogTables: [catalogTable(Machine, machines), catalogTable(Recipe, recipes)],
      reader: new PostgresCatalogSizeReader(db),
      warnRows: 1_000,
      log: silent,
    });
    expect(oversized).toEqual([
      {
        wireName: "sizeaudit/machine",
        tableName: "size_audit_machines",
        estimatedRows: 1200,
        warnRows: 1_000,
      },
    ]);
  });
});
