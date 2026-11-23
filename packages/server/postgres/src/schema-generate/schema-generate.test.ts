import { describe, expect, it } from "vitest";
import type { CatalogColumn, CatalogSnapshot, CatalogTable } from "./catalog-types.js";
import { inferDefaultTableMetadata, snakeToCamel, snakeToKebab } from "./default-table-metadata.js";
import { generateDatabaseTableFiles } from "./generate-database-tables.js";
import { normalizeCatalogSnapshot } from "./normalize-catalog.js";
import { computeTableSchemaFingerprint, tableSchemaFingerprints, tableSchemaKey } from "./table-schema-fingerprint.js";

function col(
  overrides: Partial<CatalogColumn> & Pick<CatalogColumn, "name" | "ordinal" | "formattedType">,
): CatalogColumn {
  const udtName = overrides.udtName ?? overrides.formattedType.replace(/\(.*\)$/, "").replace(/\[\]$/, "");
  return {
    udtSchema: "pg_catalog",
    isNullable: false,
    defaultExpression: null,
    isIdentity: false,
    identityGeneration: null,
    isGenerated: false,
    generatedExpression: null,
    arrayDimensions: overrides.formattedType.endsWith("[]") ? 1 : 0,
    ...overrides,
    udtName,
  };
}

function emptyTable(name: string, schema = "public"): CatalogTable {
  return {
    schema,
    name,
    columns: [],
    constraints: [],
    indexes: [],
    triggers: [],
  };
}

describe("normalizeCatalogSnapshot & tableSchemaFingerprints", () => {
  it("sorts schemas, enums, tables, columns, constraints, indexes, and triggers deterministically", () => {
    const unordered: CatalogSnapshot = {
      schemas: ["public", "billing", "public"],
      enums: [
        { schema: "public", name: "note_status", labels: ["draft", "published", "archived"] },
        { schema: "billing", name: "currency", labels: ["USD", "EUR"] },
      ],
      tables: [
        {
          schema: "public",
          name: "notes",
          columns: [
            col({ name: "title", ordinal: 2, formattedType: "text" }),
            col({ name: "id", ordinal: 1, formattedType: "uuid" }),
          ],
          constraints: [
            {
              name: "notes_title_check",
              kind: "check",
              definition: "CHECK ((length(title) > 0))",
              columns: ["title"],
              referencedSchema: null,
              referencedTable: null,
              referencedColumns: [],
              onUpdate: null,
              onDelete: null,
              checkExpression: "(length(title) > 0)",
            },
            {
              name: "notes_pkey",
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
          indexes: [
            {
              name: "notes_title_idx",
              isUnique: false,
              isPrimary: false,
              accessMethod: "btree",
              definition: "CREATE INDEX notes_title_idx ON public.notes USING btree (title)",
              columns: ["title"],
              expressions: ["title"],
              wherePredicate: null,
            },
            {
              name: "notes_pkey",
              isUnique: true,
              isPrimary: true,
              accessMethod: "btree",
              definition: "CREATE UNIQUE INDEX notes_pkey ON public.notes USING btree (id)",
              columns: ["id"],
              expressions: ["id"],
              wherePredicate: null,
            },
          ],
          triggers: [
            { name: "z_trigger", definition: "CREATE TRIGGER z_trigger ...", isInternal: false },
            { name: "a_trigger", definition: "CREATE TRIGGER a_trigger ...", isInternal: false },
          ],
        },
        { ...emptyTable("invoices", "billing") },
      ],
    };

    const normalized = normalizeCatalogSnapshot(unordered);

    expect(normalized.schemas).toEqual(["billing", "public"]);
    expect(normalized.enums.map((e) => `${e.schema}.${e.name}`)).toEqual(["billing.currency", "public.note_status"]);
    // Enum label order is semantically meaningful and must be preserved.
    expect(normalized.enums[1]?.labels).toEqual(["draft", "published", "archived"]);
    expect(normalized.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["billing.invoices", "public.notes"]);
    expect(normalized.tables[1]?.columns.map((c) => c.name)).toEqual(["id", "title"]);
    expect(normalized.tables[1]?.constraints.map((c) => c.name)).toEqual(["notes_pkey", "notes_title_check"]);
    expect(normalized.tables[1]?.indexes.map((i) => i.name)).toEqual(["notes_pkey", "notes_title_idx"]);
    expect(normalized.tables[1]?.triggers.map((t) => t.name)).toEqual(["a_trigger", "z_trigger"]);
  });

  it("produces identical 16-hex fingerprints regardless of input order and changes when triggers or retired columns change", () => {
    const baseTable: CatalogTable = {
      schema: "public",
      name: "notes",
      columns: [
        col({ name: "id", ordinal: 1, formattedType: "uuid" }),
        col({ name: "legacy_code", ordinal: 2, formattedType: "text", isNullable: true }),
      ],
      constraints: [],
      indexes: [],
      triggers: [
        { name: "audit_notes", definition: "CREATE TRIGGER audit_notes AFTER INSERT ON notes", isInternal: false },
      ],
    };

    const reorderedTable: CatalogTable = {
      ...baseTable,
      columns: [...baseTable.columns].toReversed(),
    };

    const fpBase = computeTableSchemaFingerprint(baseTable);
    const fpReordered = computeTableSchemaFingerprint(reorderedTable);
    expect(fpBase).toMatch(/^[0-9a-f]{16}$/);
    expect(fpReordered).toBe(fpBase);

    const changedTrigger: CatalogTable = {
      ...baseTable,
      triggers: [
        { name: "audit_notes", definition: "CREATE TRIGGER audit_notes AFTER UPDATE ON notes", isInternal: false },
      ],
    };
    expect(computeTableSchemaFingerprint(changedTrigger)).not.toBe(fpBase);

    const catalog: CatalogSnapshot = { schemas: ["public"], enums: [], tables: [baseTable] };
    const map = tableSchemaFingerprints(catalog);
    expect(map.get(tableSchemaKey("public", "notes"))).toBe(fpBase);

    const generated = generateDatabaseTableFiles({
      catalog,
      retiredColumns: { notes: ["legacy_code"] },
    });
    expect(generated[0]?.tables[0]?.fingerprint).toBe(fpBase);
    expect(generated[0]?.content).not.toContain("legacy_code");
    expect(generated[0]?.content).toContain(
      `// Schema fingerprint ${fpBase}: columns, constraints, indexes, triggers.`,
    );
  });
});

describe("inferDefaultTableMetadata", () => {
  it("derives camelCase export symbol and kebab-case output file path", () => {
    expect(snakeToCamel("audit_log_entries")).toBe("auditLogEntries");
    expect(snakeToKebab("audit_log_entries")).toBe("audit-log-entries");

    const meta = inferDefaultTableMetadata(emptyTable("workspace_members"), "src/database/tables/");
    expect(meta).toEqual({
      owner: "app",
      schema: "public",
      table: "workspace_members",
      outputFile: "src/database/tables/workspace-members.tables.ts",
      exportSymbol: "workspaceMembers",
      columns: {},
    });
  });
});

describe("generateDatabaseTableFiles", () => {
  it("renders uuid, branded IDs, jsonb $type, timestamps, enums, arrays, bytea/inet/xid8, and defaults", () => {
    const catalog: CatalogSnapshot = {
      schemas: ["public"],
      enums: [{ schema: "public", name: "note_status", labels: ["draft", "published"] }],
      tables: [
        {
          schema: "public",
          name: "notes",
          columns: [
            col({ name: "id", ordinal: 1, formattedType: "uuid", defaultExpression: "gen_random_uuid()" }),
            col({
              name: "status",
              ordinal: 2,
              formattedType: "note_status",
              udtSchema: "public",
              udtName: "note_status",
              defaultExpression: "'draft'::note_status",
            }),
            col({ name: "tags", ordinal: 3, formattedType: "text[]", udtName: "_text", isNullable: true }),
            col({ name: "metadata", ordinal: 4, formattedType: "jsonb", defaultExpression: "'{}'::jsonb" }),
            col({ name: "signature_blob", ordinal: 5, formattedType: "bytea", isNullable: true }),
            col({ name: "client_ip", ordinal: 6, formattedType: "inet", isNullable: true }),
            col({ name: "tx_id", ordinal: 7, formattedType: "xid8", defaultExpression: "pg_current_xact_id()" }),
            col({ name: "amount", ordinal: 8, formattedType: "numeric(12,2)", defaultExpression: "0.00" }),
            col({ name: "code", ordinal: 9, formattedType: "character varying(64)" }),
            col({ name: "is_pinned", ordinal: 10, formattedType: "boolean", defaultExpression: "false" }),
            col({
              name: "created_at",
              ordinal: 11,
              formattedType: "timestamp with time zone",
              defaultExpression: "now()",
            }),
            col({
              name: "updated_at",
              ordinal: 12,
              formattedType: "timestamp with time zone",
              defaultExpression: "now()",
            }),
            col({ name: "due_date", ordinal: 13, formattedType: "date", isNullable: true }),
          ],
          constraints: [
            {
              name: "notes_pkey",
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

    const files = generateDatabaseTableFiles({
      catalog,
      metadata: [
        {
          owner: "notes",
          table: "notes",
          outputFile: "src/database/notes.tables.ts",
          exportSymbol: "notesTable",
          documentation: "User-authored workspace notes.",
          columns: {
            id: { brandType: "NoteId", brandImport: "../note.ids.js" },
            metadata: { jsonType: "NoteMetadata", jsonImport: "../note-metadata.js" },
            updated_at: { onUpdateNow: true },
            due_date: { dateMode: "date" },
          },
        },
      ],
    });

    expect(files).toHaveLength(1);
    const content = files[0]?.content ?? "";
    expect(content).toContain("// GENERATED - DO NOT EDIT. Author a migration, then regenerate Drizzle tables.");
    expect(content).toContain('import { sql } from "drizzle-orm";');
    expect(content).toContain('import { bytea, inet, xid8 } from "@dads-framework/postgres";');
    expect(content).toContain('import type { NoteId } from "../note.ids.js";');
    expect(content).toContain('import type { NoteMetadata } from "../note-metadata.js";');
    expect(content).toContain('export const noteStatusEnum = pgEnum("note_status", ["draft", "published"]);');
    expect(content).toContain('id: uuid("id").primaryKey().defaultRandom().notNull().$type<NoteId>(),');
    expect(content).toContain('status: noteStatusEnum("status").default("draft").notNull(),');
    expect(content).toContain('tags: text("tags").array(),');
    expect(content).toContain('metadata: jsonb("metadata").default({}).notNull().$type<NoteMetadata>(),');
    expect(content).toContain('signatureBlob: bytea("signature_blob"),');
    expect(content).toContain('clientIp: inet("client_ip"),');
    expect(content).toContain('txId: xid8("tx_id").default(sql`pg_current_xact_id()`).notNull(),');
    expect(content).toContain('amount: numeric("amount", { precision: 12, scale: 2 }).default("0.00").notNull(),');
    expect(content).toContain('code: varchar("code", { length: 64 }).notNull(),');
    expect(content).toContain('isPinned: boolean("is_pinned").default(false).notNull(),');
    expect(content).toContain('createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),');
    expect(content).toContain(
      'updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),',
    );
    expect(content).toContain('dueDate: date("due_date", { mode: "date" }),');
  });

  it("renders composite PK, composite FK, inline FK, partial/unique/expression indexes, check constraints, and relations", () => {
    const catalog: CatalogSnapshot = {
      schemas: ["public"],
      enums: [],
      tables: [
        {
          schema: "public",
          name: "workspaces",
          columns: [
            col({ name: "tenant_id", ordinal: 1, formattedType: "uuid" }),
            col({ name: "workspace_id", ordinal: 2, formattedType: "uuid" }),
          ],
          constraints: [
            {
              name: "workspaces_pkey",
              kind: "primary_key",
              definition: "PRIMARY KEY (tenant_id, workspace_id)",
              columns: ["tenant_id", "workspace_id"],
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
        {
          schema: "public",
          name: "documents",
          columns: [
            col({ name: "id", ordinal: 1, formattedType: "uuid" }),
            col({ name: "tenant_id", ordinal: 2, formattedType: "uuid" }),
            col({ name: "workspace_id", ordinal: 3, formattedType: "uuid" }),
            col({ name: "parent_id", ordinal: 4, formattedType: "uuid", isNullable: true }),
            col({ name: "slug", ordinal: 5, formattedType: "text" }),
            col({ name: "deleted_at", ordinal: 6, formattedType: "timestamp with time zone", isNullable: true }),
            col({ name: "version", ordinal: 7, formattedType: "integer", defaultExpression: "1" }),
          ],
          constraints: [
            {
              name: "documents_pkey",
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
            {
              name: "documents_workspace_fkey",
              kind: "foreign_key",
              definition:
                "FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces(tenant_id, workspace_id) ON DELETE CASCADE",
              columns: ["tenant_id", "workspace_id"],
              referencedSchema: "public",
              referencedTable: "workspaces",
              referencedColumns: ["tenant_id", "workspace_id"],
              onUpdate: "no_action",
              onDelete: "cascade",
              checkExpression: null,
            },
            {
              name: "documents_parent_fkey",
              kind: "foreign_key",
              definition: "FOREIGN KEY (parent_id) REFERENCES public.documents(id) ON DELETE SET NULL",
              columns: ["parent_id"],
              referencedSchema: "public",
              referencedTable: "documents",
              referencedColumns: ["id"],
              onUpdate: "no_action",
              onDelete: "set_null",
              checkExpression: null,
            },
            {
              name: "documents_version_positive",
              kind: "check",
              definition: "CHECK ((version > 0))",
              columns: ["version"],
              referencedSchema: null,
              referencedTable: null,
              referencedColumns: [],
              onUpdate: null,
              onDelete: null,
              checkExpression: "(version > 0)",
            },
          ],
          indexes: [
            {
              name: "documents_active_slug_uidx",
              isUnique: true,
              isPrimary: false,
              accessMethod: "btree",
              definition:
                "CREATE UNIQUE INDEX documents_active_slug_uidx ON public.documents USING btree (workspace_id, lower(slug)) WHERE (deleted_at IS NULL)",
              columns: ["workspace_id"],
              expressions: ["workspace_id", "lower(slug)"],
              wherePredicate: "(deleted_at IS NULL)",
            },
          ],
          triggers: [],
        },
      ],
    };

    const files = generateDatabaseTableFiles({
      catalog,
      defaultOutputDir: "src/tables",
      metadata: [
        {
          owner: "documents",
          table: "documents",
          outputFile: "src/tables/documents.tables.ts",
          exportSymbol: "documents",
          relations: [
            {
              exportSymbol: "documentsRelations",
              entries: [
                {
                  propertyName: "workspace",
                  kind: "one",
                  targetSymbol: "workspaces",
                  fields: ["tenantId", "workspaceId"],
                  references: ["tenantId", "workspaceId"],
                },
              ],
            },
          ],
        },
      ],
    });

    const workspacesFile = files.find((f) => f.outputFile === "src/tables/workspaces.tables.ts");
    const documentsFile = files.find((f) => f.outputFile === "src/tables/documents.tables.ts");

    expect(workspacesFile?.content).toContain(
      'primaryKey({ name: "workspaces_pkey", columns: [table.tenantId, table.workspaceId] })',
    );
    expect(documentsFile?.content).toContain('import { workspaces } from "./workspaces.tables.js";');
    expect(documentsFile?.content).toContain("type AnyPgColumn");
    expect(documentsFile?.content).toContain(
      'parentId: uuid("parent_id").references((): AnyPgColumn => documents.id, { onDelete: "set null" }),',
    );
    expect(documentsFile?.content).toContain(
      'foreignKey({ name: "documents_workspace_fkey", columns: [table.tenantId, table.workspaceId], foreignColumns: [workspaces.tenantId, workspaces.workspaceId] }).onDelete("cascade")',
    );
    expect(documentsFile?.content).toContain(
      'uniqueIndex("documents_active_slug_uidx").on(table.workspaceId, sql`lower(slug)`).where(sql`(deleted_at IS NULL)`)',
    );
    expect(documentsFile?.content).toContain('check("documents_version_positive", sql`(version > 0)`)');
    expect(documentsFile?.content).toContain("export const documentsRelations = relations(documents, ({ one }) => ({");
  });
});
