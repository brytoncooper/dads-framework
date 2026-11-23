import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDomainMigrations } from "./discover-domain-migrations.js";
import { applicationMigrationWorkspace, type MigrationSource } from "./migration-workspace.js";
import { listShippedDatabaseMigrations } from "./shipped-migration-files.js";

function migrationSourceText(dependsOn: readonly string[] = []): string {
  return [
    `export const dependsOn = ${JSON.stringify(dependsOn)};`,
    "export function up() {}",
    "export function down() {}",
    "",
  ].join("\n");
}

async function createTempWorkspace(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "app-migration-workspace-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}

describe("applicationMigrationWorkspace", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = undefined;
    }
  });

  it("returns an empty list when neither migrations/ nor domains/ exists", async () => {
    workspaceRoot = await createTempWorkspace({});
    const workspace = applicationMigrationWorkspace(workspaceRoot);

    expect(await discoverDomainMigrations({ workspace })).toEqual([]);
    expect(await listShippedDatabaseMigrations(workspace)).toEqual([]);
  });

  it("discovers root migrations, per-domain server/migrations, and nested database/migrations", async () => {
    workspaceRoot = await createTempWorkspace({
      "migrations/20260101000000_bootstrap.migration.ts": migrationSourceText(),
      "domains/billing/server/migrations/20260101000001_create_invoices.migration.ts": migrationSourceText([
        "20260101000000_bootstrap.migration",
      ]),
      "domains/notes/server/src/lib/database/migrations/20260101000002_create_notes.migration.ts": migrationSourceText([
        "20260101000000_bootstrap.migration",
      ]),
      "domains/notes/server/20260101000003_ignored.migration.ts": migrationSourceText(),
      "migrations/nested/20260101000004_ignored.migration.ts": migrationSourceText(),
    });

    const workspace = applicationMigrationWorkspace(workspaceRoot);
    const discovered = await discoverDomainMigrations({ workspace });

    expect(discovered.map((entry) => ({ id: entry.id, owner: entry.owner }))).toEqual([
      { id: "20260101000000", owner: "app" },
      { id: "20260101000001", owner: "billing" },
      { id: "20260101000002", owner: "notes" },
    ]);
  });

  it("includes extraSources and forwards moduleAliases", async () => {
    workspaceRoot = await createTempWorkspace({
      "migrations/20260102000000_app_init.migration.ts": migrationSourceText(),
      "vendor/postgres-access/migrations/20260101000000_access_tables.migration.ts": migrationSourceText(),
    });

    const accessSource: MigrationSource = {
      root: "vendor/postgres-access/migrations",
      files: /^vendor\/postgres-access\/migrations\/[^/]+\.migration\.ts$/,
      owner: "postgres-access",
      required: true,
    };

    const workspace = applicationMigrationWorkspace(workspaceRoot, {
      extraSources: [accessSource],
      moduleAliases: { "@example/schema-helpers": "src/schema-helpers.ts" },
    });

    expect(workspace.moduleAliases).toEqual({
      "@example/schema-helpers": "src/schema-helpers.ts",
    });

    const shipped = await listShippedDatabaseMigrations(workspace);
    expect(shipped.map((entry) => ({ owner: entry.owner, file: entry.file }))).toEqual([
      {
        owner: "postgres-access",
        file: "vendor/postgres-access/migrations/20260101000000_access_tables.migration.ts",
      },
      {
        owner: "app",
        file: "migrations/20260102000000_app_init.migration.ts",
      },
    ]);
  });

  it("throws when a required extraSource folder is missing", async () => {
    workspaceRoot = await createTempWorkspace({});
    const workspace = applicationMigrationWorkspace(workspaceRoot, {
      extraSources: [
        {
          root: "vendor/missing-package/migrations",
          files: /^vendor\/missing-package\/migrations\/[^/]+\.migration\.ts$/,
          owner: "missing-package",
          required: true,
        },
      ],
    });

    await expect(discoverDomainMigrations({ workspace })).rejects.toThrow(
      /vendor\/missing-package\/migrations does not exist/,
    );
  });
});
