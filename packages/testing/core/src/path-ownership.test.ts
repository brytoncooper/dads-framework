import { describe, expect, it } from "vitest";
import { owningProjectForPath, pathIsInside } from "./path-ownership.js";

const projects = [
  { id: "workspace", root: "." },
  { id: "core", root: "packages/core" },
  { id: "core-tools", root: "packages/core/tools" },
];

describe("path ownership", () => {
  it("treats a root of . as owning the whole workspace", () => {
    expect(pathIsInside("packages/core/src/index.ts", ".")).toBe(true);
    expect(pathIsInside("README.md", ".")).toBe(true);
  });

  it("owns a root itself and its descendants only", () => {
    expect(pathIsInside("packages/core", "packages/core")).toBe(true);
    expect(pathIsInside("packages/core/src/a.ts", "packages/core")).toBe(true);
    expect(pathIsInside("packages/core-x/a.ts", "packages/core")).toBe(false);
    expect(pathIsInside("packages", "packages/core")).toBe(false);
  });

  it("gives a path to the deepest matching project", () => {
    expect(owningProjectForPath(projects, "packages/core/src/a.ts")?.id).toBe("core");
    expect(owningProjectForPath(projects, "packages/core/tools/a.ts")?.id).toBe("core-tools");
    expect(owningProjectForPath(projects, "README.md")?.id).toBe("workspace");
  });

  it("answers nothing when two equally deep roots both match", () => {
    expect(
      owningProjectForPath(
        [
          { id: "left", root: "apps/api" },
          { id: "right", root: "apps/web" },
          { id: "duplicate", root: "apps/api" },
        ],
        "apps/api/src/a.ts",
      ),
    ).toBeUndefined();
  });

  it("answers nothing when no project owns the path", () => {
    expect(owningProjectForPath([{ id: "core", root: "packages/core" }], "README.md")).toBeUndefined();
  });
});
