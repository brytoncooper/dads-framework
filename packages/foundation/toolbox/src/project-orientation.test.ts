/** Proves a low-context agent can resolve ownership without scanning source. */

import { describe, expect, it } from "vitest";
import { orientProjectPath, parseDadsProject } from "./project-orientation.js";

describe("project orientation", () => {
  const project = parseDadsProject({
    schemaVersion: 1,
    capabilities: [
      {
        name: "http-server",
        recipeVersion: 1,
        profile: "strict",
        client: "typescript",
        ownedFiles: ["src/http/routes.ts"],
      },
    ],
    packages: [
      {
        name: "@dads-framework/toolbox",
        root: "packages/toolbox",
        responsibility: "Explains project ownership.",
        allowedDependencies: [],
        verification: ["npm test -w @dads-framework/toolbox"],
        skills: ["dads-orient"],
      },
    ],
  });

  it("identifies the package and workflow that own a path", () => {
    expect(orientProjectPath(project, "packages/toolbox/src/cli.ts")).toEqual({
      packageName: "@dads-framework/toolbox",
      packageRoot: "packages/toolbox",
      responsibility: "Explains project ownership.",
      allowedDependencies: [],
      verification: ["npm test -w @dads-framework/toolbox"],
      skills: ["dads-orient"],
    });
  });

  it("retains versioned capability recipes for safe future changes", () => {
    expect(project.capabilities).toEqual([
      {
        name: "http-server",
        recipeVersion: 1,
        profile: "strict",
        client: "typescript",
        ownedFiles: ["src/http/routes.ts"],
      },
    ]);
  });

  it("gives a nested path to the package with the longest matching root", () => {
    const nested = parseDadsProject({
      schemaVersion: 1,
      packages: [
        {
          name: "@dads-framework/toolbox",
          root: "packages/toolbox",
          responsibility: "Explains project ownership.",
          allowedDependencies: [],
          verification: [],
          skills: [],
        },
        {
          name: "@dads-framework/toolbox-verification",
          root: "packages/toolbox/src/verification",
          responsibility: "Owns verification execution.",
          allowedDependencies: [],
          verification: [],
          skills: [],
        },
      ],
    });

    expect(orientProjectPath(nested, "packages/toolbox/src/verification/run.ts")?.packageName).toBe(
      "@dads-framework/toolbox-verification",
    );
    expect(orientProjectPath(nested, "packages/toolbox/src/cli.ts")?.packageName).toBe("@dads-framework/toolbox");
    expect(orientProjectPath(nested, "docs/README.md")).toBeUndefined();
  });

  it("rejects an ambiguous package root", () => {
    expect(() =>
      parseDadsProject({
        schemaVersion: 1,
        packages: [
          {
            name: "first",
            root: "packages/toolbox",
            responsibility: "First owner.",
            allowedDependencies: [],
            verification: [],
            skills: [],
          },
          {
            name: "second",
            root: "packages/toolbox",
            responsibility: "Second owner.",
            allowedDependencies: [],
            verification: [],
            skills: [],
          },
        ],
      }),
    ).toThrow(/duplicate package root/i);
  });
});
