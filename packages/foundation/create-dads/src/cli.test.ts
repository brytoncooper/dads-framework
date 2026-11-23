/** Proves the shipped executable keeps its exit code, stream, and envelope promises. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const executablePath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "create-dads.js");

/** What the stand-in `npm` writes to its standard error before failing. */
const installationDiagnostic = "registry-unreachable-under-test";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("create-dads executable", () => {
  it("prints an ok envelope on standard output for a successful --json run", () => {
    const targetDirectory = join(temporaryDirectory(), "json-api");
    const npm = failingNpmShim();

    const completed = runCreateDads([targetDirectory, "--yes", "--json", "--skip-install"], npm.pathValue);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(parsedJsonObject(completed.stdout)).toMatchObject({
      ok: true,
      installed: false,
      initialization: { projectRoot: targetDirectory, unchanged: [] },
    });
    expect(readFileSync(join(targetDirectory, "package.json"), "utf8")).toContain("@dads-framework/http");
    expect(existsSync(npm.invocationLog)).toBe(false);
  });

  it("carries installation diagnostics inside the --json error instead of standard output", () => {
    const targetDirectory = join(temporaryDirectory(), "install-failure-api");
    const npm = failingNpmShim();

    const completed = runCreateDads([targetDirectory, "--yes", "--json"], npm.pathValue);

    expect(completed.status).toBe(1);
    expect(completed.stdout).toBe("");
    expect(parsedJsonObject(completed.stderr)).toEqual({
      ok: false,
      error: `npm install exited with code 1: ${installationDiagnostic}`,
    });
    expect(existsSync(npm.invocationLog)).toBe(true);
    expect(existsSync(join(targetDirectory, "package.json"))).toBe(true);
  });

  it("reports a failed Docker startup as incomplete and keeps the installed project", () => {
    const targetDirectory = join(temporaryDirectory(), "docker-unavailable");
    const shimDirectory = temporaryDirectory();
    writeFileSync(
      join(shimDirectory, "npm"),
      [
        "#!/bin/sh",
        'if [ "$1" = "install" ]; then',
        "  mkdir node_modules",
        `  printf '%s\\n' '{"lockfileVersion":3}' > package-lock.json`,
        "  exit 0",
        "fi",
        'printf "Docker daemon unavailable\n" >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const completed = runCreateDads(
      [targetDirectory, "--json"],
      `${shimDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
    );
    expect(completed.status).toBe(1);
    expect(completed.stdout).toBe("");
    const result = parsedJsonObject(completed.stderr);
    expect(result).toMatchObject({
      ok: false,
      installed: true,
      development: {
        status: "deferred",
        reason: "Local development startup exited with code 1: Docker daemon unavailable",
      },
    });
    if (!("error" in result)) throw new Error("Expected a startup diagnostic.");
    expect(result.error).toContain("npm start");
    expect(existsSync(join(targetDirectory, "package-lock.json"))).toBe(true);
  });

  it("exits nonzero and writes the failure to standard error without --json", () => {
    const targetDirectory = join(temporaryDirectory(), "mistyped-api");
    const npm = failingNpmShim();

    const completed = runCreateDads([targetDirectory, "--profil", "strict"], npm.pathValue);

    expect(completed.status).toBe(1);
    expect(completed.stdout).toBe("");
    expect(completed.stderr).toBe("Dads: Unknown option --profil.\n");
    expect(existsSync(targetDirectory)).toBe(false);
  });

  it("prints the doctor's report over an existing application before it is ready", () => {
    const targetDirectory = temporaryDirectory();
    writeFileSync(join(targetDirectory, "package.json"), '{"name":"existing-app"}\n');
    const npm = failingNpmShim();

    const completed = runCreateDads([targetDirectory, "--existing", "--yes", "--skip-install"], npm.pathValue);

    expect(completed.status).toBe(0);
    expect(completed.stdout).toContain("Anxious attachment");
    expect(completed.stdout.indexOf("Anxious attachment")).toBeLessThan(completed.stdout.indexOf("Dads project files"));
  });

  it("carries the doctor's report inside the --json envelope", () => {
    const targetDirectory = temporaryDirectory();
    writeFileSync(join(targetDirectory, "package.json"), '{"name":"existing-app"}\n');
    const npm = failingNpmShim();

    const completed = runCreateDads(
      [targetDirectory, "--existing", "--yes", "--json", "--skip-install"],
      npm.pathValue,
    );

    expect(completed.status).toBe(0);
    expect(parsedJsonObject(completed.stdout)).toMatchObject({
      ok: true,
      doctor: { ok: true, root: targetDirectory, profile: "standard" },
    });
  });

  it("runs no installation and writes no project file for --dry-run", () => {
    const targetDirectory = join(temporaryDirectory(), "planned-api");
    const npm = failingNpmShim();

    const completed = runCreateDads([targetDirectory, "--yes", "--json", "--dry-run"], npm.pathValue);

    expect(completed.status).toBe(0);
    expect(parsedJsonObject(completed.stdout)).toMatchObject({
      ok: true,
      installed: false,
    });
    expect(existsSync(join(targetDirectory, "package.json"))).toBe(false);
    expect(existsSync(npm.invocationLog)).toBe(false);
  });

  it("prints usage help for --help and -h without touching the filesystem", () => {
    const npm = failingNpmShim();
    for (const flag of ["--help", "-h"]) {
      const completed = runCreateDads([flag], npm.pathValue);
      expect(completed.status).toBe(0);
      expect(completed.stderr).toBe("");
      expect(completed.stdout).toContain("Usage: create-dads <directory> [options]");
      expect(completed.stdout).toContain("--template <minimal|example>");
      expect(existsSync(npm.invocationLog)).toBe(false);
    }
  });

  it("scaffolds --template minimal through the shipped executable and rejects invalid templates", () => {
    const targetDirectory = join(temporaryDirectory(), "minimal-cli");
    const npm = failingNpmShim();

    const completed = runCreateDads(
      [targetDirectory, "--template", "minimal", "--json", "--skip-install"],
      npm.pathValue,
    );

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(parsedJsonObject(completed.stdout)).toMatchObject({
      ok: true,
      installed: false,
      initialization: { projectRoot: targetDirectory },
    });
    expect(existsSync(join(targetDirectory, "apps/customer/app.ts"))).toBe(true);
    expect(existsSync(join(targetDirectory, "domains/notes"))).toBe(false);

    const rejectedDirectory = join(temporaryDirectory(), "bad-template-cli");
    const rejected = runCreateDads([rejectedDirectory, "--template", "unknown", "--skip-install"], npm.pathValue);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toBe("Dads: --template must be minimal or example.\n");
    expect(existsSync(rejectedDirectory)).toBe(false);
  });
});

function runCreateDads(commandArguments: readonly string[], pathValue: string) {
  return spawnSync(process.execPath, [executablePath, ...commandArguments], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathValue },
  });
}

/**
 * A stand-in `npm` that records its working directory and then fails loudly,
 * so an installation this package should not have run is visible either way.
 */
function failingNpmShim(): {
  readonly invocationLog: string;
  readonly pathValue: string;
} {
  const shimDirectory = temporaryDirectory();
  const invocationLog = join(shimDirectory, "invocations.log");
  writeFileSync(
    join(shimDirectory, "npm"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$PWD" >> "${invocationLog}"`,
      `printf '%s\\n' "${installationDiagnostic}" >&2`,
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    invocationLog,
    pathValue: `${shimDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
  };
}

function parsedJsonObject(value: string): object {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Expected one JSON object line from create-dads.");
  return parsed;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "create-dads-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}
