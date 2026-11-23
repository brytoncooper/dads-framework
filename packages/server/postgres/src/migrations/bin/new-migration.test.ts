// The authoring command must mint a unique UTC filename for a known owner,
// scaffold an explicit down, and refuse unknown owners or collisions. It
// never edits an existing migration and never guesses an owner from a table.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainMigration, resolveMigrationOwnerFolder } from "./new-migration.js";

describe("createDomainMigration", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("writes a typed scaffold under the domain migrations folder", async () => {
    workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "packages/server/organizations"), {
      recursive: true,
    });

    const result = await createDomainMigration({
      owner: "organizations",
      slug: "add_widget",
      workspaceRoot,
      now: new Date("2026-08-28T15:04:05.000Z"),
    });

    expect(result.id).toBe("20260828150405");
    expect(result.filePath).toBe(
      join(
        workspaceRoot,
        "packages/server/organizations/src/lib/database/migrations/20260828150405_add_widget.migration.ts",
      ),
    );
    const contents = await readFile(result.filePath, "utf8");
    expect(contents).not.toContain("export const id");
    expect(contents).not.toContain("export const owner");
    expect(contents).toContain("export async function up");
    expect(contents).toContain("export async function down");
    expect(contents).toContain("MigrationBuilder");
    expect(contents).toContain("export const dependsOn = [];");
  });

  it("captures every known independent frontier without a shared numbering file", async () => {
    workspaceRoot = await createWorkspace();
    const folder = join(workspaceRoot, "packages/server/organizations/src/lib/database/migrations");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "20260828100000_alpha.migration.ts"),
      "export const dependsOn = [];\nexport function up() {}\nexport const down = false;\n",
    );
    await writeFile(
      join(folder, "20260828110000_beta.migration.ts"),
      "export const dependsOn = [];\nexport function up() {}\nexport const down = false;\n",
    );

    const result = await createDomainMigration({
      owner: "organizations",
      slug: "add_widget",
      workspaceRoot,
      now: new Date("2026-08-28T15:04:05.000Z"),
    });
    const contents = await readFile(result.filePath, "utf8");

    expect(contents).toContain('"20260828100000_alpha.migration"');
    expect(contents).toContain('"20260828110000_beta.migration"');
  });

  it("resolves a server part owner and the application owner", async () => {
    workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "packages/server/authorization"), {
      recursive: true,
    });

    expect(resolveMigrationOwnerFolder(workspaceRoot, "authorization")).toBe(
      join(workspaceRoot, "packages/server/authorization/src/lib/database/migrations"),
    );
    expect(resolveMigrationOwnerFolder(workspaceRoot, "app")).toBe(join(workspaceRoot, "migrations"));
  });

  it("refuses an unknown owner instead of guessing from a table name", async () => {
    workspaceRoot = await createWorkspace();
    await expect(
      createDomainMigration({
        owner: "widgets",
        slug: "add_column",
        workspaceRoot,
      }),
    ).rejects.toThrow(/unknown migration owner/);
  });

  it("refuses a colliding filename and does not rewrite the existing file", async () => {
    workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "packages/server/organizations"), {
      recursive: true,
    });
    const existing = join(
      workspaceRoot,
      "packages/server/organizations/src/lib/database/migrations/20260828150405_add_widget.migration.ts",
    );
    await mkdir(join(existing, ".."), { recursive: true });
    await writeFile(existing, "export const kept = true;\n");

    await expect(
      createDomainMigration({
        owner: "organizations",
        slug: "add_widget",
        workspaceRoot,
        now: new Date("2026-08-28T15:04:05.000Z"),
      }),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(existing, "utf8")).toBe("export const kept = true;\n");
  });
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "new-domain-migration-"));
  await Promise.all(["packages/server"].map((root) => mkdir(join(workspaceRoot, root), { recursive: true })));
  return workspaceRoot;
}
