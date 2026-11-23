import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importZedSchema } from "./access-import.js";

const dadExecutable = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "dad.js");

const RICH_ZED_SCHEMA = `use expiration

definition user {}

definition group {
  relation member: user | group#member
}

definition organization {
  relation admin: user
  permission manage = admin
}

definition folder {
  relation parent: folder | organization
  relation viewer: user | user:* | group#member | user with expiration
  permission view = viewer + parent->view + parent->manage
}

definition document {
  relation parent: folder
  relation approver: group
  relation owner: user | user with expiration
  permission view = owner + parent->view
  permission publish = owner & approver.all(member)
}
`;

const CAVEAT_ZED_SCHEMA = `definition user {}

caveat ip_allowlist(user_ip ipaddress, allowed_cidr string) {
  user_ip.in_cidr(allowed_cidr)
}

definition document {
  relation viewer: user with ip_allowlist
}
`;

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("importZedSchema", () => {
  it("reads a .zed schema, emits strict TypeScript, and reports metadata", () => {
    const workspace = createWorkspace();
    const schemaPath = join(workspace, "schema.zed");
    writeFileSync(schemaPath, RICH_ZED_SCHEMA, "utf8");

    const result = importZedSchema({
      inputPath: "schema.zed",
      cwd: workspace,
    });

    expect(result.inputPath).toBe(schemaPath);
    expect(result.outPath).toBeNull();
    expect(result.definitionCount).toBe(5);
    expect(result.definitions).toEqual(["user", "group", "organization", "folder", "document"]);
    expect(result.dryRun).toBe(false);
    expect(result.written).toBe(false);
    expect(result.code).toContain('from "@dads-framework/access"');
    expect(result.code).toContain('export const user = actor("user");');
    expect(result.code).toContain('resource("document",');
    expect(result.code).toContain("user.expiring");
    expect(result.code).toContain("user.anyone");
    expect(result.code).toContain("every(");
    expect(result.code).toContain("export const access = compileAccess(");
  });

  it("writes to outPath creating parent directories unless dryRun is true", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), RICH_ZED_SCHEMA, "utf8");
    const outPath = join(workspace, "nested", "access", "schema.ts");

    const preview = importZedSchema({
      inputPath: "schema.zed",
      outPath: "nested/access/schema.ts",
      dryRun: true,
      cwd: workspace,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.written).toBe(false);
    expect(preview.outPath).toBe(outPath);
    expect(existsSync(outPath)).toBe(false);

    const written = importZedSchema({
      inputPath: "schema.zed",
      outPath: "nested/access/schema.ts",
      cwd: workspace,
    });
    expect(written.dryRun).toBe(false);
    expect(written.written).toBe(true);
    expect(written.outPath).toBe(outPath);
    expect(readFileSync(outPath, "utf8")).toBe(written.code);
  });
});

describe("dad access import CLI", () => {
  it("prints strict Dads TypeScript to stdout by default", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), RICH_ZED_SCHEMA, "utf8");

    const completed = runDad(workspace, ["access", "import", "schema.zed"]);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toContain('from "@dads-framework/access"');
    expect(completed.stdout).toContain('export const user = actor("user");');
    expect(completed.stdout).toContain('resource("folder",');
    expect(completed.stdout).toContain("user.expiring");
    expect(completed.stdout).toContain("user.anyone");
    expect(completed.stdout).toContain("every(");
    expect(completed.stdout).toContain("export const access = compileAccess(");
  });

  it("writes the generated TypeScript file when --out is given", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), RICH_ZED_SCHEMA, "utf8");
    const outPath = join(workspace, "generated", "access.ts");

    const completed = runDad(workspace, ["access", "import", "schema.zed", "--out", "generated/access.ts"]);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toContain("Imported 5 definitions");
    expect(completed.stdout).toContain(outPath);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf8")).toContain("export const access = compileAccess(");
  });

  it("does not write the file when --dry-run is passed", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), RICH_ZED_SCHEMA, "utf8");
    const outPath = join(workspace, "dry", "access.ts");

    const completed = runDad(workspace, ["access", "import", "schema.zed", "--out", "dry/access.ts", "--dry-run"]);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toContain("Dry run: would import 5 definitions");
    expect(existsSync(outPath)).toBe(false);
  });

  it("emits structured JSON when --json is passed", () => {
    const workspace = createWorkspace();
    const schemaPath = join(workspace, "schema.zed");
    const outPath = join(workspace, "out", "access.ts");
    writeFileSync(schemaPath, RICH_ZED_SCHEMA, "utf8");

    const completed = runDad(workspace, [
      "access",
      "import",
      "schema.zed",
      "--out",
      "out/access.ts",
      "--dry-run",
      "--json",
    ]);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(existsSync(outPath)).toBe(false);
    const parsed = parseJsonRecord(completed.stdout);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["inputPath"]).toBe(schemaPath);
    expect(parsed["outPath"]).toBe(outPath);
    expect(parsed["definitionCount"]).toBe(5);
    expect(parsed["definitions"]).toEqual(["user", "group", "organization", "folder", "document"]);
    expect(parsed["dryRun"]).toBe(true);
    expect(parsed["written"]).toBe(false);
    expect(typeof parsed["code"]).toBe("string");
    expect(String(parsed["code"])).toContain("export const access = compileAccess(");
  });

  it("returns nonzero exit with line-numbered error on unsupported caveat", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "caveat.zed"), CAVEAT_ZED_SCHEMA, "utf8");

    const plain = runDad(workspace, ["access", "import", "caveat.zed"]);
    expect(plain.status).toBe(1);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("line 3:");
    expect(plain.stderr).toContain('unsupported SpiceDB construct "caveat"');

    const jsonRun = runDad(workspace, ["access", "import", "caveat.zed", "--json"]);
    expect(jsonRun.status).toBe(1);
    expect(jsonRun.stdout).toBe("");
    const payload = parseJsonRecord(jsonRun.stderr);
    expect(payload["ok"]).toBe(false);
    expect(String(payload["error"])).toContain("line 3:");
    expect(String(payload["error"])).toContain("caveat");
  });

  it("rejects missing input files, unknown flags, and malformed arguments", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "schema.zed"), "definition user {}\n", "utf8");

    const missing = runDad(workspace, ["access", "import", "does-not-exist.zed"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("Zed schema file not found:");

    const unknownFlag = runDad(workspace, ["access", "import", "schema.zed", "--wat"]);
    expect(unknownFlag.status).toBe(1);
    expect(unknownFlag.stderr).toContain("Dad: Unknown option --wat.");

    const missingPath = runDad(workspace, ["access", "import"]);
    expect(missingPath.status).toBe(1);
    expect(missingPath.stderr).toContain("Dad: access import requires a path to a .zed schema file.");

    const missingOutValue = runDad(workspace, ["access", "import", "schema.zed", "--out"]);
    expect(missingOutValue.status).toBe(1);
    expect(missingOutValue.stderr).toContain("Dad: --out requires a value.");

    const unknownSubcommand = runDad(workspace, ["access", "export"]);
    expect(unknownSubcommand.status).toBe(1);
    expect(unknownSubcommand.stderr).toContain("Usage: dad access import <schema.zed>");
  });

  it("prints help for dad access --help and dad access import --help", () => {
    const workspace = createWorkspace();

    const accessHelp = runDad(workspace, ["access", "--help"]);
    expect(accessHelp.status).toBe(0);
    expect(accessHelp.stdout).toContain("Usage: dad access <subcommand>");
    expect(accessHelp.stdout).toContain("access import <schema.zed> [--out <path>] [--dry-run] [--json]");

    const importHelp = runDad(workspace, ["access", "import", "--help"]);
    expect(importHelp.status).toBe(0);
    expect(importHelp.stdout).toContain("Usage: dad access <subcommand>");
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
