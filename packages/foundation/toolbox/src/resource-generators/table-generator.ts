import { readdirSync } from "node:fs";
import { join } from "node:path";

import { isMissingPathError } from "../missing-path-error.js";
import type { GenerationPlan } from "./generation-plan.js";
import { camel, databaseName } from "./names.js";

export function addTable(plan: GenerationPlan, root: string, domain: string, name: string): void {
  const dir = `domains/${domain}/server`;
  const item = camel(name);
  const table = databaseName(domain, name);
  plan.create(
    `${dir}/${name}-table.ts`,
    `import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const ${item}Table = pgTable("${table}", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  title: text("title").notNull(),
  rowVersion: integer("row_version").notNull().default(1),
});
`,
  );
  const migrationsDir = `${dir}/migrations`;
  const migration = migrationFile(join(root, migrationsDir), table);
  const migrationPath = `${migrationsDir}/${migration}`;
  plan.create(migrationPath, migrationSource(table));
  registerMigrations(plan, domain, migrationsDir);
}

function migrationFile(directory: string, table: string): string {
  const files = listMigrations(directory);
  const suffix = `_${table}.migration.ts`;
  const existing = files.find((file) => file.endsWith(suffix));
  if (existing !== undefined) return existing;
  const timestamp = nextTimestamp(files);
  return `${timestamp}${suffix}`;
}

function listMigrations(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function nextTimestamp(files: readonly string[]): string {
  const cutoff =
    files
      .map((file) => file.match(/^\d{14}(?=_)/)?.[0] ?? "")
      .sort()
      .at(-1) ?? "";
  const now = new Date();
  const today = migrationTimestamp(now);
  if (today > cutoff) return today;
  const date = [cutoff.slice(0, 4), cutoff.slice(4, 6), cutoff.slice(6, 8)].join("-");
  const time = [cutoff.slice(8, 10), cutoff.slice(10, 12), cutoff.slice(12, 14)].join(":");
  return migrationTimestamp(new Date(new Date(`${date}T${time}Z`).getTime() + 1_000));
}

function migrationTimestamp(time: Date): string {
  return time
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
}

function migrationSource(table: string): string {
  return `import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn: readonly string[] = [];

export function up(pgm: MigrationBuilder): void {
  pgm.createTable("${table}", {
    id: { type: "text", primaryKey: true },
    tenant_id: { type: "text", notNull: true },
    title: { type: "text", notNull: true },
    row_version: { type: "integer", notNull: true, default: 1 },
  });
  pgm.createIndex("${table}", ["tenant_id", "id"]);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("${table}");
}
`;
}

function registerMigrations(plan: GenerationPlan, domain: string, root: string): void {
  const name = `${camel(domain)}Migrations`;
  const file = `domains/${domain}/server/migration-source.ts`;
  plan.create(
    file,
    `import type { MigrationSource } from "@dads-framework/postgres/migrations";

export const ${name}: MigrationSource = {
  owner: "${domain}",
  root: "${root}",
  files: /^domains\\/${domain}\\/server\\/migrations\\/[^/]+\\.migration\\.ts$/,
  required: true,
};
`,
  );
  const publicIndex = `domains/${domain}/index.ts`;
  const entry = `export { ${name} } from "./server/migration-source.js";`;
  plan.appendLine(publicIndex, "// dad:add exports", entry);
  const registry = "assembly/migrations.ts";
  plan.appendLine(registry, "// dad:add imports", `import { ${name} } from "../domains/${domain}/index.js";`);
  plan.appendLine(registry, "// dad:add migrations", `  ${name},`);
}
