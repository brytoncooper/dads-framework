import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diffZedSchemas } from "./access-diff.js";
import {
  DEFAULT_ACCESS_MIGRATIONS_DIR,
  scaffoldAccessMigration,
} from "./access-migrate.js";
import { renderZedAccessTree } from "./access-tree.js";

const dadExecutable = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "dad.js",
);

const HIERARCHY_SCHEMA = `use expiration

definition user {}

definition group {
  relation member: user | group#member
}

definition organization {
  relation admin: user
  permission manage = admin
  permission view = admin
}

definition folder {
  relation organization: organization
  relation parent: folder
  relation viewer: user | user:* | group#member | user with expiration
  permission manage = organization->manage
  permission view = organization->view + viewer + parent->view
}

definition document {
  relation folder: folder
  relation approver: group
  relation owner: user | user with expiration
  relation banned: user
  permission view = (owner + folder->view) - banned
  permission publish = owner & approver.all(member)
}
`;

const BASE_SCHEMA = `use expiration

definition user {}

definition team {
  relation member: user
}

definition document {
  relation owner: user | user with expiration
  relation editor: user | team#member
  relation viewer: user
  permission edit = owner + editor
  permission view = edit + viewer
}

definition legacy_note {
  relation author: user
  permission read = author
}
`;

const SAFE_EVOLVED_SCHEMA = `use expiration

definition user {}

definition team {
  relation member: user
}

definition document {
  relation owner: user | user with expiration
  relation editor: user | team#member | user:*
  relation viewer: user | user with expiration
  relation commenter: user
  permission edit = owner + editor
  permission view = edit + viewer + commenter
  permission share = owner
}

definition legacy_note {
  relation author: user
}

definition audit_log {
  relation auditor: user
  permission inspect = auditor
}
`;

const BREAKING_EVOLVED_SCHEMA = `use expiration

definition user {}

definition team {
  relation member: user
}

definition document {
  relation owner: user
  relation writer: user
  relation viewer: user
  permission edit = owner + writer
  permission view = edit + viewer
}
`;

const NARROWED_SCHEMA = `use expiration

definition user {}

definition team {
  relation member: user
}

definition document {
  relation owner: user
  relation editor: user
  relation viewer: user
  permission edit = owner + editor
  permission view = edit + viewer
}

definition legacy_note {
  relation author: user
  permission read = author
}
`;

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("renderZedAccessTree and dad access tree", () => {
  it("lowers a parsed .zed schema and renders the ASCII hierarchy tree", () => {
    const workspace = createWorkspace();
    const schemaPath = join(workspace, "schema.zed");
    writeFileSync(schemaPath, HIERARCHY_SCHEMA, "utf8");

    const result = renderZedAccessTree({
      inputPath: "schema.zed",
      cwd: workspace,
    });

    expect(result.inputPath).toBe(schemaPath);
    expect(result.definitionCount).toBe(5);
    expect(result.definitions).toEqual([
      "user",
      "group",
      "organization",
      "folder",
      "document",
    ]);
    expect(result.tree).toContain("actors: user");
    expect(result.tree).toContain("organization");
    expect(result.tree).toContain("folder (recursive)");
    expect(result.tree).toContain("user [expiring]");
    expect(result.tree).toContain("user:*");
    expect(result.tree).toContain("group#member");
    expect(result.tree).toContain("manage = organization->manage [inherited]");
    expect(result.tree).toContain("approver.all(member)");
  });

  it("prints plain ASCII tree and structured JSON through the CLI", () => {
    const workspace = createWorkspace();
    const schemaPath = join(workspace, "schema.zed");
    writeFileSync(schemaPath, HIERARCHY_SCHEMA, "utf8");

    const plain = runDad(workspace, ["access", "tree", "schema.zed"]);
    expect(plain.status).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toContain("actors: user");
    expect(plain.stdout).toContain("folder (recursive)");
    expect(plain.stdout).toContain("document");

    const jsonRun = runDad(workspace, [
      "access",
      "tree",
      "schema.zed",
      "--json",
    ]);
    expect(jsonRun.status).toBe(0);
    expect(jsonRun.stderr).toBe("");
    const parsed = parseJsonRecord(jsonRun.stdout);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["inputPath"]).toBe(schemaPath);
    expect(parsed["definitionCount"]).toBe(5);
    expect(parsed["definitions"]).toEqual([
      "user",
      "group",
      "organization",
      "folder",
      "document",
    ]);
    expect(String(parsed["tree"])).toContain("actors: user");
  });

  it("rejects missing paths, unknown flags, and missing files", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), "definition user {}\n");

    const missingArg = runDad(workspace, ["access", "tree"]);
    expect(missingArg.status).toBe(1);
    expect(missingArg.stderr).toContain(
      "Dad: access tree requires a path to a .ts or .zed access file.",
    );

    const unknownOpt = runDad(workspace, [
      "access",
      "tree",
      "schema.zed",
      "--bogus",
    ]);
    expect(unknownOpt.status).toBe(1);
    expect(unknownOpt.stderr).toContain("Dad: Unknown option --bogus.");

    const missingFile = runDad(workspace, ["access", "tree", "missing.zed"]);
    expect(missingFile.status).toBe(1);
    expect(missingFile.stderr).toContain("Zed schema file not found:");
  });
});

describe("diffZedSchemas and dad access diff", () => {
  it("reports no changes when before and after schemas match", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "a.zed"), BASE_SCHEMA, "utf8");
    writeFileSync(join(workspace, "b.zed"), BASE_SCHEMA, "utf8");

    const result = diffZedSchemas({
      beforePath: "a.zed",
      afterPath: "b.zed",
      cwd: workspace,
    });

    expect(result.diff.requiresMigration).toBe(false);
    expect(result.diff.safe).toEqual([]);
    expect(result.diff.breaking).toEqual([]);
    expect(result.diff.summary).toBe("No access schema changes.");
  });

  it("classifies additive resources, roles, widening, expiration, and permissions as safe", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "before.zed"), BASE_SCHEMA, "utf8");
    writeFileSync(join(workspace, "after.zed"), SAFE_EVOLVED_SCHEMA, "utf8");

    const result = diffZedSchemas({
      beforePath: "before.zed",
      afterPath: "after.zed",
      cwd: workspace,
    });

    expect(result.diff.requiresMigration).toBe(false);
    expect(result.diff.breaking).toEqual([]);
    const safeKinds = result.diff.safe.map((entry) => entry.kind);
    expect(safeKinds).toContain("added-resource");
    expect(safeKinds).toContain("added-role");
    expect(safeKinds).toContain("widened-role");
    expect(safeKinds).toContain("added-expiration");
    expect(safeKinds).toContain("added-permission");
    expect(safeKinds).toContain("modified-permission");
    expect(safeKinds).toContain("removed-permission");

    const cliPlain = runDad(workspace, [
      "access",
      "diff",
      "before.zed",
      "after.zed",
    ]);
    expect(cliPlain.status).toBe(0);
    expect(cliPlain.stdout).toContain("requiresMigration: false");
    expect(cliPlain.stdout).toContain("Safe changes:");
  });

  it("classifies removed resource, removed role, narrowed role, and removed expiration as breaking", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "before.zed"), BASE_SCHEMA, "utf8");
    writeFileSync(join(workspace, "breaking.zed"), BREAKING_EVOLVED_SCHEMA);
    writeFileSync(join(workspace, "narrowed.zed"), NARROWED_SCHEMA, "utf8");

    const breakingResult = diffZedSchemas({
      beforePath: "before.zed",
      afterPath: "breaking.zed",
      cwd: workspace,
    });
    expect(breakingResult.diff.requiresMigration).toBe(true);
    expect(breakingResult.diff.breaking).toContainEqual({
      kind: "removed-resource",
      resource: "legacy_note",
    });
    expect(breakingResult.diff.breaking).toContainEqual({
      kind: "removed-role",
      resource: "document",
      role: "editor",
    });
    expect(breakingResult.diff.breaking).toContainEqual({
      kind: "removed-expiration",
      resource: "document",
      role: "owner",
      subject: "user",
    });

    const narrowedResult = diffZedSchemas({
      beforePath: "before.zed",
      afterPath: "narrowed.zed",
      cwd: workspace,
    });
    expect(narrowedResult.diff.requiresMigration).toBe(true);
    expect(narrowedResult.diff.breaking).toContainEqual({
      kind: "narrowed-role",
      resource: "document",
      role: "editor",
      subject: "team#member",
    });

    const jsonRun = runDad(workspace, [
      "access",
      "diff",
      "before.zed",
      "breaking.zed",
      "--json",
    ]);
    expect(jsonRun.status).toBe(0);
    expect(jsonRun.stderr).toBe("");
    const parsed = parseJsonRecord(jsonRun.stdout);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["requiresMigration"]).toBe(true);
    expect(Array.isArray(parsed["breaking"])).toBe(true);
    expect(String(parsed["summary"])).toContain("Migration required");
  });

  it("rejects incomplete arguments on dad access diff", () => {
    const workspace = createWorkspace();
    const missingSecond = runDad(workspace, ["access", "diff", "before.zed"]);
    expect(missingSecond.status).toBe(1);
    expect(missingSecond.stderr).toContain(
      "Dad: access diff requires <before> and <after> schema file paths (.ts or .zed).",
    );
  });
});

describe("scaffoldAccessMigration and dad access migrate", () => {
  it("scaffolds a numbered migration file with copyRole/dropRole stubs and snapshot metadata", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "before.zed"), BASE_SCHEMA, "utf8");
    writeFileSync(join(workspace, "after.zed"), BREAKING_EVOLVED_SCHEMA);

    const result = scaffoldAccessMigration({
      slug: "replace_editor_with_writer",
      fromPath: "before.zed",
      toPath: "after.zed",
      cwd: workspace,
    });

    const expectedDir = join(workspace, DEFAULT_ACCESS_MIGRATIONS_DIR);
    const expectedFile = join(
      expectedDir,
      "0001_replace_editor_with_writer.ts",
    );
    expect(result.id).toBe("0001_replace_editor_with_writer");
    expect(result.outDir).toBe(expectedDir);
    expect(result.filePath).toBe(expectedFile);
    expect(result.written).toBe(true);
    expect(result.requiresMigration).toBe(true);
    expect(existsSync(expectedFile)).toBe(true);

    const content = readFileSync(expectedFile, "utf8");
    expect(content).toContain("defineAccessMigration(");
    expect(content).toContain("export const migrationSnapshot = {");
    expect(content).toContain('"0001_replace_editor_with_writer"');
    expect(content).toContain(
      '// ops.copyRole({ resource: "document", role: "editor" }, { resource: "document", role: "writer" }),',
    );
    expect(content).toContain(
      'ops.dropRole({ resource: "document", role: "editor" }),',
    );
    expect(content).toContain(
      'ops.dropRole({ resource: "legacy_note", role: "author" }),',
    );
    expect(content).toContain("removed expiration on document#owner (user)");
  });

  it("assigns sequential NNNN_<slug> IDs and respects --dry-run and --json via CLI", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "before.zed"), BASE_SCHEMA, "utf8");
    writeFileSync(join(workspace, "after.zed"), SAFE_EVOLVED_SCHEMA, "utf8");
    const customDir = join(workspace, "migrations");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, "0002_seed.ts"), "// existing\n", "utf8");

    const dryRun = runDad(workspace, [
      "access",
      "migrate",
      "add_audit_log",
      "--from",
      "before.zed",
      "--to",
      "after.zed",
      "--out",
      "migrations",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe("");
    const dryPayload = parseJsonRecord(dryRun.stdout);
    expect(dryPayload["ok"]).toBe(true);
    expect(dryPayload["id"]).toBe("0003_add_audit_log");
    expect(dryPayload["dryRun"]).toBe(true);
    expect(dryPayload["written"]).toBe(false);
    expect(dryPayload["requiresMigration"]).toBe(false);
    expect(existsSync(join(customDir, "0003_add_audit_log.ts"))).toBe(false);

    const liveRun = runDad(workspace, [
      "access",
      "migrate",
      "add_audit_log",
      "--from",
      "before.zed",
      "--to",
      "after.zed",
      "--out",
      "migrations",
    ]);
    expect(liveRun.status).toBe(0);
    expect(liveRun.stderr).toBe("");
    expect(liveRun.stdout).toContain("Scaffolded migration 0003_add_audit_log");
    expect(liveRun.stdout).toContain("requiresMigration: false");
    const writtenPath = join(customDir, "0003_add_audit_log.ts");
    expect(existsSync(writtenPath)).toBe(true);
    expect(readFileSync(writtenPath, "utf8")).toContain("steps: () => [");

    const nextRun = runDad(workspace, [
      "access",
      "migrate",
      "follow-up",
      "--from",
      "before.zed",
      "--to",
      "after.zed",
      "--out",
      "migrations",
    ]);
    expect(nextRun.status).toBe(0);
    expect(existsSync(join(customDir, "0004_follow-up.ts"))).toBe(true);
  });

  it("rejects invalid slugs and missing required migrate options", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "a.zed"), BASE_SCHEMA, "utf8");

    const missingSlug = runDad(workspace, [
      "access",
      "migrate",
      "--from",
      "a.zed",
      "--to",
      "a.zed",
    ]);
    expect(missingSlug.status).toBe(1);
    expect(missingSlug.stderr).toContain(
      "Dad: access migrate requires a migration slug.",
    );

    const missingFrom = runDad(workspace, [
      "access",
      "migrate",
      "my_migration",
      "--to",
      "a.zed",
    ]);
    expect(missingFrom.status).toBe(1);
    expect(missingFrom.stderr).toContain(
      "Dad: access migrate requires --from <before>.",
    );

    const missingTo = runDad(workspace, [
      "access",
      "migrate",
      "my_migration",
      "--from",
      "a.zed",
    ]);
    expect(missingTo.status).toBe(1);
    expect(missingTo.stderr).toContain(
      "Dad: access migrate requires --to <after>.",
    );

    const badSlug = runDad(workspace, [
      "access",
      "migrate",
      "../escape",
      "--from",
      "a.zed",
      "--to",
      "a.zed",
    ]);
    expect(badSlug.status).toBe(1);
    expect(badSlug.stderr).toContain('Invalid migration slug "../escape"');
  });

  it("prints help for dad access --help and all access subcommands", () => {
    const workspace = createWorkspace();

    for (const subcommand of ["tree", "diff", "migrate"]) {
      const help = runDad(workspace, ["access", subcommand, "--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: dad access <subcommand>");
      expect(help.stdout).toContain("access tree <schema.ts|schema.zed>");
      expect(help.stdout).toContain("access diff <before> <after>");
      expect(help.stdout).toContain(
        "access migrate <slug> --from <before> --to <after>",
      );
    }
  });
});

type DadRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runDad(cwd: string, commandArguments: readonly string[]): DadRun {
  const completed = spawnSync(
    process.execPath,
    [dadExecutable, ...commandArguments],
    { cwd, encoding: "utf8" },
  );
  if (completed.error) throw completed.error;
  return {
    status: completed.status,
    stdout: completed.stdout,
    stderr: completed.stderr,
  };
}

function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "dads-access-")));
  temporaryDirs.push(workspace);
  return workspace;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    record[key] = value;
  }
  return record;
}
