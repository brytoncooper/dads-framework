import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { parseDadsProject } from "../project-orientation.js";
import { collectCandidateTasks } from "./logic/collect-candidate-tasks.js";

const manifest = new URL("../../../../../dads.project.json", import.meta.url);
const rawProject: unknown = JSON.parse(readFileSync(manifest, "utf8"));
const project = parseDadsProject(rawProject);

it("selects the registered stylesheet compiler for a changed package asset", () => {
  const plan = collectCandidateTasks(project, [
    "packages/web/styles/utilities.css",
  ]);

  expect(plan.usedFullFallback).toBe(false);
  expect(plan.unknownPaths).toEqual([]);
  expect(plan.tasks).toContainEqual(
    expect.objectContaining({
      packageName: "@dads-framework/styles",
      command: "npm test -w @dads-framework/styles",
      state: "run",
    }),
  );
});

it("preserves the full fallback for an unclassified root asset", () => {
  const plan = collectCandidateTasks(project, ["unclassified-global.css"]);

  expect(plan.usedFullFallback).toBe(true);
  expect(plan.unknownPaths).toEqual(["unclassified-global.css"]);
});
