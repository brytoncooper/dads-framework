import { describe, expect, it } from "vitest";
import type { WorkspacePackage } from "./package-inventory.js";
import { assignProjectIds, sanitizeIdentifier } from "./project-ids.js";

describe("project identifiers", () => {
  const sanitized: readonly { readonly value: string; readonly id: string }[] =
    [
      { value: "@dads-framework/testing", id: "dads-framework-testing" },
      { value: "core", id: "core" },
      { value: "my package!", id: "my-package" },
      { value: "@scope/", id: "scope" },
      { value: "packages/alpha", id: "packages-alpha" },
      { value: "---", id: "" },
      { value: "a.b:c_d", id: "a.b:c_d" },
    ];

  for (const example of sanitized) {
    it(`reduces ${example.value} to ${example.id === "" ? "nothing" : example.id}`, () => {
      expect(sanitizeIdentifier(example.value)).toBe(example.id);
    });
  }

  it("takes each id from the package name", () => {
    const assignments = assignProjectIds([
      workspacePackage("packages/core", "@scope/core"),
      workspacePackage("apps/api", "@scope/api"),
    ]);

    expect(assignments).toEqual([
      {
        directory: "packages/core",
        projectId: "scope-core",
        source: "package-name",
      },
      { directory: "apps/api", projectId: "scope-api", source: "package-name" },
    ]);
  });

  it("falls back to the directory for a repeated or missing name", () => {
    const assignments = assignProjectIds([
      workspacePackage("packages/core", "core"),
      workspacePackage("apps/core", "core"),
      workspacePackage("tools/cli"),
      workspacePackage("."),
    ]);

    expect(assignments.map((assignment) => assignment.projectId)).toEqual([
      "core",
      "apps-core",
      "tools-cli",
      "root",
    ]);
    expect(assignments.map((assignment) => assignment.source)).toEqual([
      "package-name",
      "directory",
      "directory",
      "directory",
    ]);
  });

  it("refuses two packages that resolve to the same id", () => {
    expect(() =>
      assignProjectIds([
        workspacePackage("packages/alpha", "tools-cli"),
        workspacePackage("tools/cli", "tools-cli"),
      ]),
    ).toThrow(
      "Cannot assign a unique project id: packages/alpha and tools/cli both resolve to tools-cli.",
    );
  });
});

function workspacePackage(directory: string, name?: string): WorkspacePackage {
  return {
    directory,
    ...(name === undefined ? {} : { name }),
    scripts: {},
    workspaceDependencies: [],
    tsconfigReferences: [],
    packageJsonReadable: true,
    unsupported: [],
  };
}
