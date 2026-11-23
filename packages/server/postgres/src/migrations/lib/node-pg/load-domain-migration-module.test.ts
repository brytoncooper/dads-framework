/** A CommonJS runner cannot import() a typed .migration.ts; jiti is the loader. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadDomainMigrationModule } from "./load-domain-migration-module.js";
import { defaultMigrationWorkspace, type MigrationWorkspace } from "./migration-workspace.js";

const typedMigration = `import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder): void {}
export const down = false;
`;

const jsxMigration = `import "./email-template.tsx";
export function up(): void {}
export const down = false;
`;

const jsxModule = `export const template = <><p>Migration dependency</p></>;
`;

describe("loadDomainMigrationModule", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a typed .migration.ts a CommonJS runner cannot import()", async () => {
    directory = await mkdtemp(join(process.cwd(), ".typed-migration-"));
    const filePath = join(directory, "20260101120000_typed.migration.ts");
    await writeFile(filePath, typedMigration);

    const loaded = await loadDomainMigrationModule(filePath, defaultMigrationWorkspace(process.cwd()));
    if (typeof loaded !== "object" || loaded === null || !("up" in loaded) || !("down" in loaded)) {
      expect.fail("expected migration module");
      return;
    }
    expect(loaded.down).toBe(false);
    expect(typeof loaded.up).toBe("function");
    expect(isLoadedMigration(loaded)).toBe(true);
    if (!isLoadedMigration(loaded)) {
      return;
    }
    expect(typeof loaded.up).toBe("function");
    expect(loaded.down).toBe(false);
  });

  it("loads migrations whose dependency graph includes TSX", async () => {
    directory = await mkdtemp(join(process.cwd(), ".tsx-migration-"));
    const filePath = join(directory, "20260101120000_tsx.migration.ts");
    await writeFile(filePath, jsxMigration);
    await writeFile(join(directory, "email-template.tsx"), jsxModule);

    await expect(loadDomainMigrationModule(filePath, defaultMigrationWorkspace(process.cwd()))).resolves.toBeDefined();
  });

  it("resolves a caller-supplied alias to its one source file", async () => {
    directory = await mkdtemp(join(process.cwd(), ".aliased-migration-"));
    const migrationDirectory = join(directory, "packages/server/example/src/lib/database/migrations");
    const auditDirectory = join(directory, "packages/server/audit/src/lib/database");
    await mkdir(migrationDirectory, { recursive: true });
    await mkdir(auditDirectory, { recursive: true });
    const filePath = join(migrationDirectory, "20260101120000_aliased.migration.ts");
    await writeFile(
      filePath,
      'import { marker } from "@dads-framework/audit";\nexport const loadedMarker = marker;\nexport function up(): void {}\nexport const down = false;\n',
    );
    await writeFile(join(auditDirectory, "attach-audit-trigger.ts"), 'export const marker = "audit";\n');

    const loaded = await loadDomainMigrationModule(
      filePath,
      aliasedWorkspace(directory, {
        "@dads-framework/audit": "packages/server/audit/src/lib/database/attach-audit-trigger.ts",
      }),
    );

    expect(loaded).toMatchObject({ loadedMarker: "audit" });
  });

  it("resolves every alias the caller supplies, not a fixed list", async () => {
    directory = await mkdtemp(join(process.cwd(), ".aliased-migration-"));
    const migrationDirectory = join(directory, "packages/server/example/src/lib/database/migrations");
    const syncDirectory = join(directory, "packages/server/sync/src/lib");
    await mkdir(migrationDirectory, { recursive: true });
    await mkdir(syncDirectory, { recursive: true });
    const filePath = join(migrationDirectory, "20260101120000_aliased.migration.ts");
    await writeFile(
      filePath,
      'import { marker } from "@example/sync-helpers";\nexport const loadedMarker = marker;\nexport function up(): void {}\nexport const down = false;\n',
    );
    await writeFile(join(syncDirectory, "sync-log-trigger.ts"), 'export const marker = "sync";\n');

    const loaded = await loadDomainMigrationModule(
      filePath,
      aliasedWorkspace(directory, {
        "@example/sync-helpers": "packages/server/sync/src/lib/sync-log-trigger.ts",
      }),
    );

    expect(loaded).toMatchObject({ loadedMarker: "sync" });
  });
});

function isLoadedMigration(value: unknown): value is { up: unknown; down: unknown } {
  return typeof value === "object" && value !== null && "up" in value && "down" in value;
}

function aliasedWorkspace(root: string, moduleAliases: Readonly<Record<string, string>>): MigrationWorkspace {
  return { ...defaultMigrationWorkspace(root), moduleAliases };
}
