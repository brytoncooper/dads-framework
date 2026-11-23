/** Proves both file systems obey every law of one suite, law by named law. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AliasFileSystem } from "./alias-file-system.js";
import { createAliasResolver } from "./alias-resolver.js";
import {
  aliasResolverConformanceLaws,
  runAliasResolverConformance,
  type AliasResolverConformanceFinding,
  type AliasResolverConformanceSubject,
} from "./alias-resolver-conformance.js";
import { inMemoryFileSystem } from "./in-memory-file-system.js";
import { nodeFileSystem } from "./node-file-system.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The Node provider needs the fixtures on a real disk, so the factory writes
 * them. The root is the real path, because `require.resolve` answers in real
 * paths and a macOS temporary directory is a symlink.
 */
function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-path-aliases-"));
  temporaryDirectories.push(directory);
  return realpathSync(directory);
}

function writeFiles(files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/**
 * One provider held to every law, one test each, so a broken law is named by
 * the test that failed rather than read out of a list. The run itself happens
 * once for the whole describe, because the Node provider writes its fixtures
 * to disk and every law would otherwise rebuild all of them.
 */
function obeysEveryLaw(subject: () => AliasResolverConformanceSubject): void {
  const broken: AliasResolverConformanceFinding[] = [];

  beforeAll(() => {
    broken.push(...runAliasResolverConformance(subject()));
  });

  it.each(aliasResolverConformanceLaws())("obeys %s", (law) => {
    expect(broken.filter((one) => one.law === law)).toEqual([]);
  });

  it("breaks no law outside the ones this suite names", () => {
    const named = new Set(aliasResolverConformanceLaws());
    expect(broken.filter((one) => !named.has(one.law))).toEqual([]);
  });
}

describe("the conformance suite over the in-memory stand-in", () => {
  obeysEveryLaw(() => ({
    root: resolve("/dads-path-aliases-conformance"),
    fileSystem: inMemoryFileSystem,
  }));
});

describe("the conformance suite over the Node file system", () => {
  obeysEveryLaw(() => ({
    root: temporaryRoot(),
    fileSystem: (files) => {
      writeFiles(files);
      return nodeFileSystem;
    },
  }));
});

describe("the conformance suite over a provider that lies", () => {
  it("reports a file system whose isFile says yes to everything", () => {
    const findings = runAliasResolverConformance({
      root: resolve("/dads-path-aliases-broken"),
      fileSystem: (files) => sayYesToEverything(inMemoryFileSystem(files)),
    });

    expect(findings.map((one) => one.law)).toEqual(
      expect.arrayContaining(["resolves-package-entry", "refuses-missing-tsconfig"]),
    );
    expect(findings.some((one) => one.law === "refuses-blank-tsconfig")).toBe(false);
  });
});

describe("the in-memory file system", () => {
  it("refuses to read a path it does not hold, naming the path", () => {
    const fileSystem = inMemoryFileSystem({});

    expect(() => fileSystem.readText("/nowhere/tsconfig.json")).toThrow(
      "This in-memory file system holds no file at /nowhere/tsconfig.json.",
    );
  });

  it("finds a package by the node_modules walk, and answers nothing above the root", () => {
    const fileSystem = inMemoryFileSystem({
      "/workspace/node_modules/vendor/config.json": "{}",
    });

    expect(fileSystem.resolvePackage("vendor/config.json", "/workspace/deep/a.json")).toBe(
      resolve("/workspace/node_modules/vendor/config.json"),
    );
    expect(fileSystem.resolvePackage("absent", "/workspace/a.json")).toBeUndefined();
  });
});

describe("the Node file system", () => {
  it("answers no for a directory and for an unreadable path", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "directory.json"));

    expect(nodeFileSystem.isFile(join(root, "directory.json"))).toBe(false);
    expect(nodeFileSystem.isFile(join(root, "absent.json"))).toBe(false);
  });

  it("answers nothing for a package that is not installed", () => {
    const root = temporaryRoot();
    const tsconfig = join(root, "tsconfig.json");
    writeFileSync(tsconfig, "{}\n");

    expect(nodeFileSystem.resolvePackage("@dads-framework/absent", tsconfig)).toBeUndefined();
  });
});

describe("a resolver built over one file system", () => {
  it("resolves an alias declared by the tsconfig it was named", () => {
    const files = {
      "/project/tsconfig.json": '{ "compilerOptions": { "paths": { "@app/*": ["./src/*"] } } }',
      "/project/src/ui/button.tsx": "export {};\n",
    };

    const resolveAlias = createAliasResolver({
      tsconfig: "/project/tsconfig.json",
      fileSystem: inMemoryFileSystem(files),
    });

    expect(resolveAlias("@app/ui/button")).toBe(resolve("/project/src/ui/button.tsx"));
  });

  it("resolves alias targets from the baseUrl the declaring config sets", () => {
    const files = {
      "/project/tsconfig.json": '{ "compilerOptions": { "baseUrl": "./generated", "paths": { "@app/*": ["./*"] } } }',
      "/project/generated/client.ts": "export {};\n",
    };

    const resolveAlias = createAliasResolver({
      tsconfig: "/project/tsconfig.json",
      fileSystem: inMemoryFileSystem(files),
    });

    expect(resolveAlias("@app/client")).toBe(resolve("/project/generated/client.ts"));
  });
});

/** A provider that lies about every path being a file. */
function sayYesToEverything(fileSystem: AliasFileSystem): AliasFileSystem {
  return { ...fileSystem, isFile: () => true };
}
