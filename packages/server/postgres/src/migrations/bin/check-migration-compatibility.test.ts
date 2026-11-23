import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationWorkspace } from "../index.js";
import { readMigrationCompatibilityDiff } from "./check-migration-compatibility.js";

const FOLDER = "packages/server/probe/src/lib/database/migrations";
const BASELINE = `${FOLDER}/20250101000000_baseline.migration.ts`;
const ADDITION = `${FOLDER}/20260101000000_addition.migration.ts`;

describe("migration comparison Git boundary", () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "migration-diff-"));
    git("init", "-q");
    git("config", "user.name", "Migration test");
    git("config", "user.email", "migration-test@example.invalid");
    await mkdir(join(root, FOLDER), { recursive: true });
    await writeFile(join(root, BASELINE), "export function up() {}\n");
    git("add", ".");
    git("commit", "-qm", "fixture baseline");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns no database work for unrelated edits", async () => {
    await writeFile(join(root, "feature.ts"), "export const value = 1;\n");
    expect(
      (
        await readMigrationCompatibilityDiff(
          defaultMigrationWorkspace(root),
          "HEAD",
        )
      ).addedFiles,
    ).toEqual([]);
  });

  it("includes untracked pending additions without changing their files", async () => {
    await writeFile(join(root, ADDITION), "export const dependsOn = [];\n");
    expect(
      await readMigrationCompatibilityDiff(
        defaultMigrationWorkspace(root),
        "HEAD",
      ),
    ).toEqual({
      base: git("rev-parse", "HEAD"),
      baselineFiles: [BASELINE],
      addedFiles: [ADDITION],
    });
    expect(git("status", "--porcelain")).toContain("??");
  });

  it("refuses edited or removed baseline history", async () => {
    await writeFile(
      join(root, BASELINE),
      "export function up() { dangerous(); }\n",
    );
    await expect(
      readMigrationCompatibilityDiff(defaultMigrationWorkspace(root), "HEAD"),
    ).rejects.toThrow();
    await rm(join(root, BASELINE));
    await expect(
      readMigrationCompatibilityDiff(defaultMigrationWorkspace(root), "HEAD"),
    ).rejects.toThrow();
  });

  it("accepts only an owner-approved deletion, and leaves it out of the baseline", async () => {
    const approvals = join(root, "migrations/approved-undeployed-edits.json");
    await mkdir(dirname(approvals), { recursive: true });
    await writeFile(
      approvals,
      JSON.stringify({ edits: [], deletions: [{ file: BASELINE }] }),
    );
    await rm(join(root, BASELINE));
    expect(
      await readMigrationCompatibilityDiff(
        defaultMigrationWorkspace(root),
        "HEAD",
      ),
    ).toEqual({
      base: git("rev-parse", "HEAD"),
      baselineFiles: [],
      addedFiles: [],
    });

    await writeFile(approvals, JSON.stringify({ edits: [], deletions: [] }));
    await expect(
      readMigrationCompatibilityDiff(defaultMigrationWorkspace(root), "HEAD"),
    ).rejects.toThrow(/immutable baseline migration differs/);
  });

  it("refuses an unavailable comparison ref", async () => {
    await expect(
      readMigrationCompatibilityDiff(
        defaultMigrationWorkspace(root),
        "missing-base",
      ),
    ).rejects.toThrow();
  });

  it("does not include another product's migrations", async () => {
    const vector = join(
      root,
      "libs/vector/domains/probe/server/src/lib/database/migrations/new.migration.ts",
    );
    await mkdir(dirname(vector), { recursive: true });
    await writeFile(vector, "export function up() {}\n");
    expect(
      (
        await readMigrationCompatibilityDiff(
          defaultMigrationWorkspace(root),
          "HEAD",
        )
      ).addedFiles,
    ).toEqual([]);
  });

  it("refuses changes to a baseline migration's transitive runtime helper", async () => {
    await writeFile(
      join(root, BASELINE),
      'import { sql } from "./support"; export function up(pgm) { pgm.sql(sql); }',
    );
    await mkdir(join(root, FOLDER, "support"));
    await writeFile(
      join(root, FOLDER, "support/index.ts"),
      'export { sql } from "./ddl";',
    );
    await writeFile(
      join(root, FOLDER, "support/ddl.ts"),
      'export const sql = "CREATE TABLE kept (id integer)";',
    );
    git("add", ".");
    git("commit", "-qm", "fixture immutable support");
    await writeFile(join(root, ADDITION), "export const dependsOn = [];\n");
    await writeFile(
      join(root, FOLDER, "support/ddl.ts"),
      'export const sql = "CREATE TABLE kept (different text)";',
    );
    await expect(
      readMigrationCompatibilityDiff(defaultMigrationWorkspace(root), "HEAD"),
    ).rejects.toThrow(/baseline migration support/);
  });

  it("refuses an untracked module shadowing the baseline's directory import", async () => {
    await writeFile(
      join(root, BASELINE),
      'import { sql } from "./support"; export function up(pgm) { pgm.sql(sql); }',
    );
    await mkdir(join(root, FOLDER, "support"));
    await writeFile(
      join(root, FOLDER, "support/index.ts"),
      'export const sql = "CREATE TABLE kept (id integer)";',
    );
    git("add", ".");
    git("commit", "-qm", "fixture directory support");
    await writeFile(join(root, ADDITION), "export const dependsOn = [];\n");
    await writeFile(
      join(root, FOLDER, "support.ts"),
      'export const sql = "CREATE TABLE kept (different text)";',
    );
    await expect(
      readMigrationCompatibilityDiff(defaultMigrationWorkspace(root), "HEAD"),
    ).rejects.toThrow(/untracked shadow/);
  });
});
