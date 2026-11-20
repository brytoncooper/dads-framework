/** Proves the installed CLI points at a tracked executable, not compiler output. */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Dad CLI package", () => {
  it("ships an executable wrapper that survives a TypeScript rebuild", () => {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const packageManifest: unknown = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    const executablePath = readDadExecutable(packageManifest);

    expect(readPackageName(packageManifest)).toBe("@dads-framework/toolbox");
    expect(executablePath).toBe("./bin/dad.js");
    expect(statSync(join(packageRoot, executablePath)).mode & 0o111).not.toBe(
      0,
    );
  });

  it("lists registered workflows and examples in CLI help", () => {
    const dad = fileURLToPath(new URL("../bin/dad.js", import.meta.url));
    const help = execFileSync(process.execPath, [dad, "--help"], {
      encoding: "utf8",
    });
    for (const example of [
      "init <path>",
      "add library <name>",
      "add domain|endpoint|table|access|flag|email|page|resource <name>",
      "orient|explain <path>",
      "check boundaries",
      "baseline init",
      "doctor [path]",
      "dad add resource products --api customer --dry-run",
    ]) {
      expect(help).toContain(example);
    }
    expect(help).not.toContain("authorization:postgres");
  });

  it("lists every generator in add help without opening a project", () => {
    const dad = fileURLToPath(new URL("../bin/dad.js", import.meta.url));
    const help = execFileSync(process.execPath, [dad, "add", "--help"], {
      encoding: "utf8",
    });
    expect(help).toContain("Usage: dad add <generator>");
    expect(help).toContain("add library <name>");
    expect(help).toContain(
      "add domain|endpoint|table|access|flag|email|page|resource <name>",
    );
  });
});

function readPackageName(packageManifest: unknown): string {
  if (typeof packageManifest !== "object" || packageManifest === null) {
    throw new Error("Expected a package manifest object.");
  }
  const name: unknown = Reflect.get(packageManifest, "name");
  if (typeof name !== "string") {
    throw new Error("Expected a package name.");
  }
  return name;
}

function readDadExecutable(packageManifest: unknown): string {
  if (typeof packageManifest !== "object" || packageManifest === null) {
    throw new Error("Expected a package manifest object.");
  }
  const bin: unknown = Reflect.get(packageManifest, "bin");
  if (typeof bin !== "object" || bin === null) {
    throw new Error("Expected a Dads bin declaration.");
  }
  expect(Reflect.has(bin, "dads")).toBe(false);
  const executable: unknown = Reflect.get(bin, "dad");
  if (typeof executable !== "string") {
    throw new Error("Expected the Dad executable path.");
  }
  return executable;
}
