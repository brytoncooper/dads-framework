import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileWorkspaceGlob, expandWorkspaceGlobs } from "./workspace-glob.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const workspaceFiles: Readonly<Record<string, string>> = {
  "package.json": "{}",
  "packages/alpha/package.json": "{}",
  "packages/alpha/node_modules/dependency/package.json": "{}",
  "packages/beta/package.json": "{}",
  "packages/beta/nested/package.json": "{}",
  "packages/testing-native-darwin/package.json": "{}",
  "packages/no-package/readme.md": "",
  "apps/web/package.json": "{}",
  "apps/web/sub/package.json": "{}",
  "tools/cli/package.json": "{}",
  "node_modules/vendor/package.json": "{}",
  ".hidden/package.json": "{}",
};

describe("workspace globbing", () => {
  const expansions: readonly {
    readonly name: string;
    readonly patterns: readonly string[];
    readonly expected: readonly string[];
  }[] = [
    {
      name: "matches one segment with *",
      patterns: ["packages/*"],
      expected: ["packages/alpha", "packages/beta", "packages/testing-native-darwin"],
    },
    {
      name: "matches any depth with **",
      patterns: ["packages/**"],
      expected: ["packages/alpha", "packages/beta", "packages/beta/nested", "packages/testing-native-darwin"],
    },
    {
      name: "matches a literal segment after a wildcard",
      patterns: ["apps/*/sub"],
      expected: ["apps/web/sub"],
    },
    {
      name: "matches a prefix inside one segment",
      patterns: ["packages/testing-native-*"],
      expected: ["packages/testing-native-darwin"],
    },
    {
      name: "removes what a later negation excludes",
      patterns: ["packages/*", "!packages/testing-native-*"],
      expected: ["packages/alpha", "packages/beta"],
    },
    {
      name: "accepts an explicit directory",
      patterns: ["tools/cli"],
      expected: ["tools/cli"],
    },
    {
      name: "ignores a leading ./ and a trailing /",
      patterns: ["./packages/*/"],
      expected: ["packages/alpha", "packages/beta", "packages/testing-native-darwin"],
    },
    {
      name: "skips node_modules and dot directories",
      patterns: ["**"],
      expected: [
        "apps/web",
        "apps/web/sub",
        "packages/alpha",
        "packages/beta",
        "packages/beta/nested",
        "packages/testing-native-darwin",
        "tools/cli",
      ],
    },
  ];

  for (const expansion of expansions) {
    it(expansion.name, () => {
      const workspaceRoot = makeWorkspace();

      expect(expandWorkspaceGlobs(workspaceRoot, expansion.patterns)).toEqual(expansion.expected);
    });
  }

  it("excludes directories without a package.json", () => {
    const workspaceRoot = makeWorkspace();

    expect(expandWorkspaceGlobs(workspaceRoot, ["packages/*"])).not.toContain("packages/no-package");
  });

  it("names the pattern it cannot compile", () => {
    expect(() => compileWorkspaceGlob("packages/{a,b}")).toThrow(
      "Unsupported workspace pattern packages/{a,b}; dad-test init understands literal segments, *, ** and a leading !.",
    );
  });

  it("reports the negation and the pattern it compiled", () => {
    const negated = compileWorkspaceGlob("!packages/*");

    expect(negated.pattern).toBe("!packages/*");
    expect(negated.negated).toBe(true);
    expect(negated.matches("packages/alpha")).toBe(true);
    expect(negated.matches("packages/alpha/nested")).toBe(false);
  });
});

function makeWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-glob-"));
  temporaryDirectories.push(directory);
  for (const [relativePath, contents] of Object.entries(workspaceFiles)) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return directory;
}
