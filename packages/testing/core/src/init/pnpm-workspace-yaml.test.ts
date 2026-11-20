import { describe, expect, it } from "vitest";
import { parsePnpmWorkspaceFile } from "./pnpm-workspace-yaml.js";

describe("pnpm workspace file reading", () => {
  it("reads a block list with comments and quotes", () => {
    const text = [
      "---",
      "# the packages of this workspace",
      "packages:",
      "  - packages/*        # every package",
      "  - 'apps/*'",
      '  - "tools/cli"',
      "",
      "  - fixtures/**",
    ].join("\n");

    expect(parsePnpmWorkspaceFile(text, "pnpm-workspace.yaml")).toEqual({
      packages: ["packages/*", "apps/*", "tools/cli", "fixtures/**"],
      ignoredKeys: [],
    });
  });

  it("reads a one-line flow list", () => {
    const parsed = parsePnpmWorkspaceFile(
      "packages: [\"packages/*\", 'apps/*']\n",
      "pnpm-workspace.yaml",
    );

    expect(parsed.packages).toEqual(["packages/*", "apps/*"]);
  });

  it("skips another top-level key and reports it", () => {
    const text = [
      "packages:",
      "  - packages/*",
      "catalog:",
      "  react: ^19.0.0",
      "  react-dom: ^19.0.0",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "",
    ].join("\n");

    expect(parsePnpmWorkspaceFile(text, "pnpm-workspace.yaml")).toEqual({
      packages: ["packages/*"],
      ignoredKeys: ["catalog", "onlyBuiltDependencies"],
    });
  });

  it("refuses an anchor at the file and line it appears on", () => {
    const text = ["packages:", "  - packages/*", "  - &shared apps/*", ""].join(
      "\n",
    );

    expect(() => parsePnpmWorkspaceFile(text, "pnpm-workspace.yaml")).toThrow(
      "pnpm-workspace.yaml:3: unsupported YAML; dad-test init reads only a packages: list of strings.",
    );
  });

  const refusals: readonly { readonly name: string; readonly text: string }[] =
    [
      { name: "an alias", text: "packages:\n  - *shared\n" },
      { name: "a block scalar", text: "packages:\n  - |\n      packages/*\n" },
      { name: "a tab", text: "packages:\n\t- packages/*\n" },
      {
        name: "a nested map",
        text: "packages:\n  include:\n    - packages/*\n",
      },
      {
        name: "a second document",
        text: "---\npackages:\n  - packages/*\n---\npackages:\n  - apps/*\n",
      },
    ];

  for (const refusal of refusals) {
    it(`refuses ${refusal.name}`, () => {
      expect(() =>
        parsePnpmWorkspaceFile(refusal.text, "workspace.yaml"),
      ).toThrow(
        /^workspace\.yaml:\d+: unsupported YAML; dad-test init reads only a packages: list of strings\.$/,
      );
    });
  }

  it("refuses a file without a packages key", () => {
    expect(() =>
      parsePnpmWorkspaceFile("catalog:\n  react: ^19.0.0\n", "workspace.yaml"),
    ).toThrow(
      /^workspace\.yaml:\d+: unsupported YAML; dad-test init reads only a packages: list of strings\.$/,
    );
  });
});
