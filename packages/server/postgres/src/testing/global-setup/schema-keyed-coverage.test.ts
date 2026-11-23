/**
 * What: a schema-keyed suite fails when it touches a table its hash does not cover.
 * Why: a missed table means a migration to it would replay the suite's cached pass.
 */
import { describe, expect, it } from "vitest";

import {
  checkSchemaKeyedCoverage,
  describeCoverageFailure,
  readSchemaKeyedDeclaration,
  tableModuleInput,
} from "./schema-keyed-coverage.js";
import { privateDatabaseName } from "./verify-schema-keyed-suite.js";

const ORDERS = "apps/example/domains/orders/server/src/lib/database/generated-tables";
const FACILITIES = "apps/example/domains/facilities/server/src/lib/database/generated-tables";
const AUDIT = "packages/server/audit/src/lib/database/generated-tables";

const owners = new Map([
  ["orders", ORDERS],
  ["facilities", FACILITIES],
  ["audit_log", AUDIT],
]);

const ordersSuite = readSchemaKeyedDeclaration([
  "default",
  "^production",
  "databaseSharedState",
  "integrationRuntime",
  tableModuleInput(ORDERS),
]);

describe("readSchemaKeyedDeclaration", () => {
  it("reads the marker and the table-module folders", () => {
    expect(ordersSuite).toEqual({
      schemaKeyed: true,
      tableModuleFolders: [ORDERS],
    });
  });

  it("treats the all-migrations input as not schema-keyed", () => {
    expect(readSchemaKeyedDeclaration(["default", "databaseMigrations"]).schemaKeyed).toBe(false);
    expect(readSchemaKeyedDeclaration(undefined).schemaKeyed).toBe(false);
  });
});

describe("checkSchemaKeyedCoverage", () => {
  it("passes when the suite declares application and kit tables it reached", () => {
    const report = checkSchemaKeyedCoverage({
      declaration: {
        ...ordersSuite,
        tableModuleFolders: [ORDERS, AUDIT],
      },
      tableOwners: owners,
      touched: [
        { schemaName: "public", tableName: "orders" },
        { schemaName: "public", tableName: "audit_log" },
        { schemaName: "public", tableName: "a_table_the_test_created" },
      ],
      unmigratedDatabases: 0,
    });
    expect(report.missingFolders).toEqual([]);
    expect(describeCoverageFailure("domain-orders", report)).toBeNull();
  });

  it("names the input to add when a trigger or query reached another domain's table", () => {
    const report = checkSchemaKeyedCoverage({
      declaration: ordersSuite,
      tableOwners: owners,
      touched: [
        { schemaName: "public", tableName: "orders" },
        { schemaName: "public", tableName: "facilities" },
      ],
      unmigratedDatabases: 0,
    });
    expect(report.missingFolders).toEqual([FACILITIES]);
    expect(describeCoverageFailure("domain-orders", report)).toContain(`"${tableModuleInput(FACILITIES)}",`);
  });

  it("sends a suite that reads the journal or migrates its own database back to all migrations", () => {
    const report = checkSchemaKeyedCoverage({
      declaration: ordersSuite,
      tableOwners: owners,
      touched: [
        {
          schemaName: "dads_migration",
          tableName: "dads_node_pg_migrations",
        },
      ],
      unmigratedDatabases: 1,
    });
    expect(report.needsAllMigrations).toHaveLength(2);
    expect(describeCoverageFailure("domain-orders", report)).toContain('list "databaseMigrations" instead');
  });
});

describe("privateDatabaseName", () => {
  it("keeps the old name without a run prefix and marks template use with one", () => {
    expect(privateDatabaseName(undefined, true, "abc")).toBe("test_abc");
    expect(privateDatabaseName("p1", true, "abc")).toBe("test_p1_m_abc");
    expect(privateDatabaseName("p1", false, "abc")).toBe("test_p1_u_abc");
  });
});
