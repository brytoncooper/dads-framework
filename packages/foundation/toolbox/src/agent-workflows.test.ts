import { describe, expect, it } from "vitest";
import { parseDadsProject } from "./project-orientation.js";
import { recommendChangedVerification } from "./recommend-changed-verification.js";

const project = parseDadsProject({
  schemaVersion: 1,
  packages: [
    {
      name: "documents",
      root: "packages/documents",
      responsibility: "Owns documents.",
      allowedDependencies: [],
      verification: ["npm test -w documents"],
      skills: ["add-http-operation"],
    },
    {
      name: "search",
      root: "packages/search",
      responsibility: "Indexes documents.",
      allowedDependencies: ["documents"],
      verification: ["npm test -w search"],
      skills: ["dads-orient"],
    },
  ],
});

describe("agent workflows", () => {
  it("recommends focused verification from changed ownership", () => {
    const recommendation = recommendChangedVerification(project, ["packages/documents/src/create.ts"]);

    expect(recommendation.packages).toEqual([
      {
        packageName: "documents",
        reason: "packages/documents/src/create.ts changed.",
        commands: ["npm test -w documents"],
      },
      {
        packageName: "search",
        reason: "Depends on documents:verify:1.",
        commands: ["npm test -w search"],
      },
    ]);
    expect(recommendation.complete).toBe(true);
    expect(recommendation.usedFullFallback).toBe(false);
  });

  it("includes consumers when a provider changes", () => {
    const recommendation = recommendChangedVerification(project, ["packages/documents/src/create.ts"]);

    expect(recommendation.packages.map((entry) => entry.packageName)).toEqual(["documents", "search"]);
    expect(recommendation.tasks.map((entry) => entry.state)).toEqual(["run", "run"]);
  });

  it("uses conservative verification for an unowned executable change", () => {
    const recommendation = recommendChangedVerification(project, ["tools/release.mjs"]);

    expect(recommendation.packages.map((entry) => entry.packageName)).toEqual(["documents", "search"]);
    expect(recommendation.unownedPaths).toEqual(["tools/release.mjs"]);
    expect(recommendation.tasks.map((entry) => entry.state)).toEqual(["unknown-scope", "unknown-scope"]);
    expect(recommendation.complete).toBe(true);
  });
});
