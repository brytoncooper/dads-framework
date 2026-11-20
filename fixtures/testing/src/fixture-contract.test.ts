import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("testing fixture manifest", () => {
  it("declares an exhaustive full fallback and dependency ordered tasks", () => {
    const rawManifest: unknown = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "dads.testing.json"),
        "utf8",
      ),
    );
    if (!isFixtureManifest(rawManifest))
      throw new Error("Fixture manifest is not shaped as expected.");
    const manifest = rawManifest;
    expect(manifest.workspace.fullFallback.taskIds).toEqual(
      manifest.tasks.map((task) => task.id),
    );
    expect(
      manifest.tasks.find((task) => task.id === "fixture:test")?.dependsOn,
    ).toEqual(["fixture:typecheck"]);
  });
});

type FixtureManifest = {
  readonly workspace: {
    readonly fullFallback: { readonly taskIds: readonly string[] };
  };
  readonly tasks: readonly {
    readonly id: string;
    readonly dependsOn: readonly string[];
  }[];
};

function isFixtureManifest(value: unknown): value is FixtureManifest {
  if (!isUnknownRecord(value)) return false;
  const workspace = value["workspace"];
  const tasks = value["tasks"];
  if (!isUnknownRecord(workspace) || !isUnknownArray(tasks)) return false;

  const fullFallback = workspace["fullFallback"];
  return (
    isUnknownRecord(fullFallback) &&
    isStringArray(fullFallback["taskIds"]) &&
    tasks.every(isFixtureTask)
  );
}

function isFixtureTask(
  value: unknown,
): value is FixtureManifest["tasks"][number] {
  if (!isUnknownRecord(value)) return false;
  return typeof value["id"] === "string" && isStringArray(value["dependsOn"]);
}

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    isUnknownArray(value) && value.every((entry) => typeof entry === "string")
  );
}
