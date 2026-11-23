/**
 * What is the plugin's, and only that. Every alias, probe, and refusal the
 * resolver owns is proven in `@dads-framework/testing/path-aliases`, against both the
 * Node file system and the in-memory stand-in.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { dadsTsconfigPaths } from "./dads-tsconfig-paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("dadsTsconfigPaths", () => {
  it("refuses a blank tsconfig option before reading anything", () => {
    for (const tsconfig of ["", "   "]) {
      expect(() => dadsTsconfigPaths({ tsconfig })).toThrow("dadsTsconfigPaths requires a non-empty tsconfig path.");
    }
  });

  it("exposes an inspectable pre-resolution Vite plugin", () => {
    const fixture = createFixture();

    const plugin = dadsTsconfigPaths({ tsconfig: fixture.tsconfig });

    expect(plugin.name).toBe("dads-tsconfig-paths");
    expect(plugin.enforce).toBe("pre");
  });

  it("answers resolveId with the resolver's path, and defers what it does not own", () => {
    const fixture = createFixture();

    const resolveId = resolveIdOf(dadsTsconfigPaths({ tsconfig: fixture.tsconfig }));

    expect(resolveId("@fixture/core")).toBe(fixture.coreFile);
    expect(resolveId("react")).toBeNull();
  });

  it("fails while the plugin is being created, not while a module is resolved", () => {
    const absent = join(temporaryFixtureDirectory(), "absent.json");

    expect(() => dadsTsconfigPaths({ tsconfig: absent })).toThrow(
      `Dads path aliases tsconfig is not a readable file: ${absent}`,
    );
  });
});

/** The plugin's own `resolveId`, read off the plugin a caller would install. */
function resolveIdOf(plugin: Plugin): (specifier: string) => unknown {
  const hook: unknown = plugin.resolveId;
  if (!isResolveIdHook(hook)) {
    throw new Error("dadsTsconfigPaths must expose resolveId as a function.");
  }
  return hook;
}

function isResolveIdHook(value: unknown): value is (specifier: string) => unknown {
  return typeof value === "function";
}

function createFixture(): {
  readonly tsconfig: string;
  readonly coreFile: string;
} {
  const root = temporaryFixtureDirectory();
  mkdirSync(join(root, "src"), { recursive: true });
  const coreFile = join(root, "src", "core.ts");
  writeFileSync(coreFile, "export {};\n");
  const tsconfig = join(root, "tsconfig.json");
  writeFileSync(tsconfig, '{ "compilerOptions": { "paths": { "@fixture/core": ["./src/core.ts"] } } }\n');
  return { tsconfig, coreFile: resolve(coreFile) };
}

function temporaryFixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-vitest-"));
  temporaryDirectories.push(directory);
  return directory;
}
