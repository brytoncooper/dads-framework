import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diffAccessSources } from "./access-diff.js";
import { scaffoldAccessMigrationFromSources } from "./access-migrate.js";
import { loadAccessSource } from "./access-source-loader.js";
import { renderAccessTree } from "./access-tree.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const dadExecutable = join(testDirectory, "..", "bin", "dad.js");
const repoNodeModules = resolve(testDirectory, "..", "..", "..", "..", "node_modules");

const COMPILED_BEFORE_TS = `import { actor, compileAccess, resource } from "@dads-framework/access";

export const user = actor("user");

export const organization = resource("organization", {
  roles: { admin: user, member: user },
  can: ({ admin, member }) => ({
    manage: admin,
    view: [admin, member],
  }),
  children: {
    document: {
      inherit: ["view"],
      roles: {
        owner: [user, user.expiring],
        editor: user,
      },
      can: ({ owner, editor }) => ({
        edit: [owner, editor],
      }),
    },
  },
});

export const access = compileAccess([organization]);
`;

const COMPILED_AFTER_TS = `import { actor, compileAccess, resource } from "@dads-framework/access";

export const user = actor("user");

export const organization = resource("organization", {
  roles: { admin: user, member: user },
  can: ({ admin, member }) => ({
    manage: admin,
    view: [admin, member],
  }),
  children: {
    document: {
      inherit: ["view"],
      roles: {
        owner: user,
        writer: user,
        viewer: [user, user.anyone],
      },
      can: ({ owner, writer, viewer }) => ({
        edit: [owner, writer],
        view: viewer,
      }),
    },
  },
});

export const access = compileAccess([organization]);
`;

const UNCOMPILED_DSL_TS = `import { actor, resource } from "@dads-framework/access";

export const user = actor("user");

export const folder = resource("folder", {
  recursive: true,
  roles: {
    viewer: [user, user.expiring],
  },
  can: ({ viewer }) => ({
    view: viewer,
  }),
  children: {
    note: {
      inherit: "all",
      roles: {
        author: user,
      },
      can: ({ author }) => ({
        edit: author,
      }),
    },
  },
});
`;

const DEFAULT_EXPORT_MODEL_TS = `import { actor, compileAccess, resource } from "@dads-framework/access";

const user = actor("user");
const workspace = resource("workspace", {
  roles: { owner: user },
  can: ({ owner }) => ({ admin: owner }),
});

export default compileAccess([workspace]);
`;

const ROUNDTRIP_ZED = `use expiration

definition user {}

definition workspace {
  relation admin: user
  permission manage = admin
  permission view = admin
}

definition document {
  relation workspace: workspace
  relation owner: user | user with expiration
  relation viewer: user | user:*
  permission view = workspace->view + owner + viewer
}
`;

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TypeScript access source loading and dad access tree", () => {
  it("loads compiled AccessModel, uncompiled DSL exports, and default exports", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "compiled.ts"), COMPILED_BEFORE_TS, "utf8");
    writeFileSync(join(workspace, "uncompiled.ts"), UNCOMPILED_DSL_TS, "utf8");
    writeFileSync(join(workspace, "default.mts"), DEFAULT_EXPORT_MODEL_TS, "utf8");

    const compiled = await renderAccessTree({
      inputPath: "compiled.ts",
      cwd: workspace,
    });
    expect(compiled.definitionCount).toBe(3);
    expect(compiled.definitions).toEqual(["user", "organization", "document"]);
    expect(compiled.tree).toContain("actors: user");
    expect(compiled.tree).toContain("organization");
    expect(compiled.tree).toContain("document");
    expect(compiled.tree).toContain("user [expiring]");

    const uncompiled = await renderAccessTree({
      inputPath: "uncompiled.ts",
      cwd: workspace,
    });
    expect(uncompiled.definitions).toEqual(["user", "folder", "note"]);
    expect(uncompiled.tree).toContain("folder (recursive)");
    expect(uncompiled.tree).toContain("note");

    const defaultLoaded = await loadAccessSource("default.mts", workspace);
    expect(defaultLoaded.kind).toBe("module");
    expect(defaultLoaded.definitions.map((def) => def.wireName)).toEqual(["user", "workspace"]);
  });

  it("renders a TypeScript access file via dad access tree CLI (plain and JSON)", () => {
    const workspace = createWorkspace();
    const filePath = join(workspace, "access.ts");
    writeFileSync(filePath, COMPILED_BEFORE_TS, "utf8");

    const plain = runDad(workspace, ["access", "tree", "access.ts"]);
    expect(plain.status).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toContain("actors: user");
    expect(plain.stdout).toContain("organization");
    expect(plain.stdout).toContain("document");

    const jsonRun = runDad(workspace, ["access", "tree", "access.ts", "--json"]);
    expect(jsonRun.status).toBe(0);
    expect(jsonRun.stderr).toBe("");
    const parsed = parseJsonRecord(jsonRun.stdout);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["inputPath"]).toBe(filePath);
    expect(parsed["definitionCount"]).toBe(3);
    expect(parsed["definitions"]).toEqual(["user", "organization", "document"]);
    expect(String(parsed["tree"])).toContain("organization");
  });

  it("reloads updated .ts files at the same path without stale ESM cache", async () => {
    const workspace = createWorkspace();
    const filePath = join(workspace, "evolving.ts");

    writeFileSync(filePath, COMPILED_BEFORE_TS, "utf8");
    const first = await loadAccessSource("evolving.ts", workspace);
    const firstDoc = first.definitions.find((def) => def.wireName === "document");
    expect(firstDoc?.roles.map((role) => role.name)).toContain("editor");

    writeFileSync(filePath, COMPILED_AFTER_TS, "utf8");
    const second = await loadAccessSource("evolving.ts", workspace);
    const secondDoc = second.definitions.find((def) => def.wireName === "document");
    expect(secondDoc?.roles.map((role) => role.name)).toContain("writer");
    expect(secondDoc?.roles.map((role) => role.name)).not.toContain("editor");
  });
});

describe("dad access diff and migrate on TypeScript files", () => {
  it("diffs two .ts files via API and CLI, detecting safe and breaking changes", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "before.ts"), COMPILED_BEFORE_TS, "utf8");
    writeFileSync(join(workspace, "after.ts"), COMPILED_AFTER_TS, "utf8");

    const diffResult = await diffAccessSources({
      beforePath: "before.ts",
      afterPath: "after.ts",
      cwd: workspace,
    });
    expect(diffResult.diff.requiresMigration).toBe(true);
    expect(diffResult.diff.breaking).toContainEqual({
      kind: "removed-role",
      resource: "document",
      role: "editor",
    });
    expect(diffResult.diff.breaking).toContainEqual({
      kind: "removed-expiration",
      resource: "document",
      role: "owner",
      subject: "user",
    });
    expect(diffResult.diff.safe).toContainEqual({
      kind: "added-role",
      resource: "document",
      role: "writer",
    });

    const cliJson = runDad(workspace, ["access", "diff", "before.ts", "after.ts", "--json"]);
    expect(cliJson.status).toBe(0);
    expect(cliJson.stderr).toBe("");
    const parsed = parseJsonRecord(cliJson.stdout);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["requiresMigration"]).toBe(true);
    expect(String(parsed["summary"])).toContain("Migration required");
  });

  it("round-trips dad access import (.zed -> .ts) into dad access tree and diff", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), ROUNDTRIP_ZED, "utf8");

    const imported = runDad(workspace, ["access", "import", "schema.zed", "--out", "imported.ts"]);
    expect(imported.status).toBe(0);
    expect(imported.stderr).toBe("");

    const tree = runDad(workspace, ["access", "tree", "imported.ts"]);
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain("workspace");
    expect(tree.stdout).toContain("document");

    const diff = runDad(workspace, ["access", "diff", "schema.zed", "imported.ts", "--json"]);
    expect(diff.status).toBe(0);
    expect(diff.stderr).toBe("");
    const payload = parseJsonRecord(diff.stdout);
    expect(payload["ok"]).toBe(true);
    expect(payload["requiresMigration"]).toBe(false);
    expect(payload["safe"]).toEqual([]);
    expect(payload["breaking"]).toEqual([]);
  });

  it("scaffolds a migration directly from two .ts files via API and CLI", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "before.ts"), COMPILED_BEFORE_TS, "utf8");
    writeFileSync(join(workspace, "after.ts"), COMPILED_AFTER_TS, "utf8");

    const preview = await scaffoldAccessMigrationFromSources({
      slug: "rename_editor_ts",
      fromPath: "before.ts",
      toPath: "after.ts",
      outDir: "migrations",
      dryRun: true,
      cwd: workspace,
    });
    expect(preview.id).toBe("0001_rename_editor_ts");
    expect(preview.requiresMigration).toBe(true);
    expect(preview.written).toBe(false);
    expect(preview.code).toContain('ops.dropRole({ resource: "document", role: "editor" })');

    const cliRun = runDad(workspace, [
      "access",
      "migrate",
      "rename_editor_ts",
      "--from",
      "before.ts",
      "--to",
      "after.ts",
      "--out",
      "migrations",
    ]);
    expect(cliRun.status).toBe(0);
    expect(cliRun.stderr).toBe("");
    expect(cliRun.stdout).toContain("Scaffolded migration 0001_rename_editor_ts");
    expect(cliRun.stdout).toContain("requiresMigration: true");

    const generatedPath = join(workspace, "migrations", "0001_rename_editor_ts.ts");
    expect(existsSync(generatedPath)).toBe(true);
    const content = readFileSync(generatedPath, "utf8");
    expect(content).toContain("defineAccessMigration(");
    expect(content).toContain(
      '// ops.copyRole({ resource: "document", role: "editor" }, { resource: "document", role: "viewer" })',
    );
    expect(content).toContain('ops.dropRole({ resource: "document", role: "editor" })');
  });

  it("reports actionable errors for missing .ts files, bad extensions, and empty modules", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "empty.ts"), "export const version = 1;\n");
    writeFileSync(join(workspace, "notes.json"), "{}\n");

    const missing = runDad(workspace, ["access", "tree", "missing.ts"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Access schema file not found:");

    const unsupported = runDad(workspace, ["access", "tree", "notes.json"]);
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain("Unsupported access schema file");

    const emptyExports = runDad(workspace, ["access", "tree", "empty.ts"]);
    expect(emptyExports.status).toBe(1);
    expect(emptyExports.stderr).toContain("No access model or DSL definitions found");
  });
});

type DadRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runDad(cwd: string, commandArguments: readonly string[]): DadRun {
  const completed = spawnSync(process.execPath, [dadExecutable, ...commandArguments], { cwd, encoding: "utf8" });
  if (completed.error) throw completed.error;
  return {
    status: completed.status,
    stdout: completed.stdout,
    stderr: completed.stderr,
  };
}

function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "dads-access-ts-")));
  symlinkSync(repoNodeModules, join(workspace, "node_modules"), "dir");
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
