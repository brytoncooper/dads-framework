import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PostgresClient } from "../lib/connect-postgres-client.js";
import type { PgPool } from "../lib/database-service.js";
import type { CatalogSnapshot } from "./catalog-types.js";
import {
  checkGeneratedTableFiles,
  generateDatabaseTableFiles,
  introspectAndGenerateTables,
  writeGeneratedTableFiles,
} from "./generate-database-tables.js";
import { introspectPostgresCatalog, type CatalogQueryClient } from "./introspect-database.js";
import { parseTableMetadata } from "./table-metadata.schema.js";

function createFakeCatalogClient(
  responses: Readonly<Record<string, readonly Record<string, unknown>[]>>,
): CatalogQueryClient {
  return {
    query(text: string) {
      if (text.includes("pg_catalog.pg_namespace") && !text.includes("JOIN")) {
        return Promise.resolve({ rows: responses["schemas"] ?? [] });
      }
      if (text.includes("pg_catalog.pg_enum")) {
        return Promise.resolve({ rows: responses["enums"] ?? [] });
      }
      if (text.includes("pg_catalog.pg_attribute")) {
        if (text.includes("pg_catalog.pg_constraint")) {
          return Promise.resolve({ rows: responses["constraints"] ?? [] });
        }
        if (text.includes("pg_catalog.pg_index")) {
          return Promise.resolve({ rows: responses["indexes"] ?? [] });
        }
        return Promise.resolve({ rows: responses["columns"] ?? [] });
      }
      if (text.includes("pg_catalog.pg_trigger")) {
        return Promise.resolve({ rows: responses["triggers"] ?? [] });
      }
      return Promise.resolve({ rows: responses["tables"] ?? [] });
    },
  };
}

describe("introspectPostgresCatalog & introspectAndGenerateTables", () => {
  it("maps pg_catalog query rows into a normalized CatalogSnapshot and generates Drizzle files", async () => {
    const client = createFakeCatalogClient({
      schemas: [{ schema_name: "public" }],
      enums: [{ schema_name: "public", enum_name: "order_state", labels: ["open", "closed"] }],
      tables: [{ schema_name: "public", table_name: "orders" }],
      columns: [
        {
          schema_name: "public",
          table_name: "orders",
          column_name: "state",
          ordinal: 2,
          formatted_type: "order_state",
          udt_schema: "public",
          udt_name: "order_state",
          is_nullable: false,
          default_expression: "'open'::order_state",
          identity_generation: "",
          generated_kind: "",
          generated_expression: null,
          array_dimensions: 0,
        },
        {
          schema_name: "public",
          table_name: "orders",
          column_name: "id",
          ordinal: 1,
          formatted_type: "uuid",
          udt_schema: "pg_catalog",
          udt_name: "uuid",
          is_nullable: false,
          default_expression: "gen_random_uuid()",
          identity_generation: "",
          generated_kind: "",
          generated_expression: null,
          array_dimensions: 0,
        },
      ],
      constraints: [
        {
          schema_name: "public",
          table_name: "orders",
          constraint_name: "orders_pkey",
          constraint_type: "p",
          definition: "PRIMARY KEY (id)",
          columns: ["id"],
          referenced_schema: null,
          referenced_table: null,
          referenced_columns: [],
          on_update: null,
          on_delete: null,
        },
      ],
      indexes: [
        {
          schema_name: "public",
          table_name: "orders",
          index_name: "orders_pkey",
          is_unique: true,
          is_primary: true,
          access_method: "btree",
          definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
          key_columns: ["id"],
          key_expressions: ["id"],
          where_predicate: null,
        },
      ],
      triggers: [],
    });

    const catalog = await introspectPostgresCatalog(client);
    expect(catalog.schemas).toEqual(["public"]);
    expect(catalog.tables).toHaveLength(1);
    expect(catalog.tables[0]?.columns.map((c) => c.name)).toEqual(["id", "state"]);

    const files = await introspectAndGenerateTables(client, { defaultOutputDir: "src/db" });
    expect(files).toHaveLength(1);
    expect(files[0]?.outputFile).toBe("src/db/orders.tables.ts");
    expect(files[0]?.content).toContain('export const orderStateEnum = pgEnum("order_state", ["open", "closed"]);');
    expect(files[0]?.content).toContain("export const orders = pgTable(");
  });

  it("returns an empty catalog when no user schemas match", async () => {
    const client = createFakeCatalogClient({ schemas: [] });
    const catalog = await introspectPostgresCatalog(client);
    expect(catalog).toEqual({ schemas: [], enums: [], tables: [] });

    // Compile-time check: both PostgresClient and PgPool satisfy CatalogQueryClient.
    const acceptClients = (c: PostgresClient, p: PgPool): readonly Promise<CatalogSnapshot>[] => [
      introspectPostgresCatalog(c),
      introspectPostgresCatalog(p),
    ];
    expect(typeof acceptClients).toBe("function");
  });
});

describe("writeGeneratedTableFiles & checkGeneratedTableFiles", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  const sampleCatalog: CatalogSnapshot = {
    schemas: ["public"],
    enums: [],
    tables: [
      {
        schema: "public",
        name: "projects",
        columns: [
          {
            name: "id",
            ordinal: 1,
            formattedType: "uuid",
            udtSchema: "pg_catalog",
            udtName: "uuid",
            isNullable: false,
            defaultExpression: "gen_random_uuid()",
            isIdentity: false,
            identityGeneration: null,
            isGenerated: false,
            generatedExpression: null,
            arrayDimensions: 0,
          },
        ],
        constraints: [
          {
            name: "projects_pkey",
            kind: "primary_key",
            definition: "PRIMARY KEY (id)",
            columns: ["id"],
            referencedSchema: null,
            referencedTable: null,
            referencedColumns: [],
            onUpdate: null,
            onDelete: null,
            checkExpression: null,
          },
        ],
        indexes: [],
        triggers: [],
      },
    ],
  };

  it("writes files, reports clean check, and detects both missing files and drifted content", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schema-generate-drift-"));
    const files = generateDatabaseTableFiles({
      catalog: sampleCatalog,
      defaultOutputDir: "generated/tables",
    });

    // Before writing, files are reported missing.
    const missingReport = await checkGeneratedTableFiles(files, tempDir);
    expect(missingReport).toEqual({
      ok: false,
      drifted: [],
      missing: ["generated/tables/projects.tables.ts"],
    });

    // After writing, files match cleanly.
    const written = await writeGeneratedTableFiles(files, tempDir);
    expect(written).toEqual(["generated/tables/projects.tables.ts"]);
    const onDisk = await readFile(join(tempDir, "generated/tables/projects.tables.ts"), "utf8");
    expect(onDisk).toBe(files[0]?.content);

    const cleanReport = await checkGeneratedTableFiles(files, tempDir);
    expect(cleanReport).toEqual({ ok: true, drifted: [], missing: [] });

    // Mutate file on disk to simulate hand-edit drift.
    await writeFile(
      join(tempDir, "generated/tables/projects.tables.ts"),
      onDisk.replace(/Schema fingerprint [0-9a-f]{16}:/, "Schema fingerprint 0000000000000000:"),
      "utf8",
    );

    const driftedReport = await checkGeneratedTableFiles(files, tempDir);
    expect(driftedReport.ok).toBe(false);
    expect(driftedReport.missing).toEqual([]);
    expect(driftedReport.drifted).toEqual([
      {
        outputFile: "generated/tables/projects.tables.ts",
        expectedFingerprints: [files[0]?.tables[0]?.fingerprint],
        actualFingerprints: ["0000000000000000"],
      },
    ]);
  });

  it("refuses output paths that escape outputRoot and rejects unknown metadata keys", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schema-generate-escape-"));
    const escaped = generateDatabaseTableFiles({
      catalog: sampleCatalog,
      metadata: [
        {
          owner: "projects",
          table: "projects",
          outputFile: "../outside.tables.ts",
          exportSymbol: "projects",
        },
      ],
    });

    await expect(writeGeneratedTableFiles(escaped, tempDir)).rejects.toThrow(/escapes outputRoot/);
    expect(() =>
      parseTableMetadata({
        owner: "projects",
        table: "projects",
        outputFile: "projects.tables.ts",
        exportSymbol: "projects",
        unknownField: true,
      }),
    ).toThrow();
  });
});
