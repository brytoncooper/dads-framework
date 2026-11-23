/**
 * The kind matrix, one row at a time.
 *
 * A package's `kind` says what it is allowed to know about, and the matrix is
 * the whole of that rule, so each row is written down here rather than left to
 * one fixture that happens to cross a line. Every declared edge is emitted,
 * allowed ones at zero included, so an edge that is removed or made legal
 * reads as being at the ceiling instead of disappearing; a third-party
 * dependency is not an edge; and a package that does not declare a recognized
 * kind stops the reading rather than counting as zero, because a package that
 * forgets to say what it is would otherwise be exempt from the only rule that
 * governs it.
 */

import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import { kindInversionsSignal } from "./kind-inversions.js";

type Declared = readonly [string, string | undefined, (readonly string[])?];

function contextOver(entries: readonly Declared[]): DoctorContext {
  const packages: readonly DoctorPackage[] = entries.map(([name, kind, allowedDependencies]) => ({
    name,
    root: `packages/${name}`,
    kind,
    allowedDependencies: allowedDependencies ?? [],
  }));
  return {
    root: "/repo",
    today: undefined,
    files: () => [],
    directories: () => [],
    read: () => "",
    exists: (path) => path === "dads.project.json",
    packages: () => packages,
    exec: () => ({ status: 1, stdout: "" }),
    online: false,
    fetch: () => {
      throw new Error("no network here");
    },
    program: () => {
      throw new Error("no program here");
    },
  };
}

async function edges(entries: readonly Declared[]): Promise<readonly (readonly [string, number])[]> {
  const readings = await kindInversionsSignal.run(contextOver(entries));
  return [...readings].map(([edge, reading]) => [edge, reading.value]);
}

describe("the kind matrix", () => {
  it("emits an edge the matrix allows at zero", async () => {
    expect(
      await edges([
        ["adapter-one", "adapter", ["core-one"]],
        ["core-one", "core"],
      ]),
    ).toStrictEqual([["adapter-one -> core-one", 0]]);
  });

  it("counts an edge the matrix forbids", async () => {
    expect(
      await edges([
        ["tooling-one", "tooling", ["adapter-one"]],
        ["adapter-one", "adapter"],
      ]),
    ).toStrictEqual([["tooling-one -> adapter-one", 1]]);
  });

  it("lets core and tooling reach an artifact, an adapter not, and an artifact reach nothing", async () => {
    expect(
      await edges([
        ["core-one", "core", ["binary-one"]],
        ["tooling-one", "tooling", ["binary-one"]],
        ["adapter-one", "adapter", ["binary-one"]],
        ["binary-one", "artifact", ["core-one"]],
      ]),
    ).toStrictEqual([
      ["core-one -> binary-one", 0],
      ["tooling-one -> binary-one", 0],
      ["adapter-one -> binary-one", 1],
      ["binary-one -> core-one", 1],
    ]);
  });

  it("lets a binding reach core and an adapter, and only a profile bind to it", async () => {
    expect(
      await edges([
        ["binding-one", "binding", ["core-one", "adapter-one"]],
        ["adapter-one", "adapter", ["binding-one"]],
        ["profile-one", "profile", ["binding-one"]],
        ["core-one", "core"],
      ]),
    ).toStrictEqual([
      ["binding-one -> core-one", 0],
      ["binding-one -> adapter-one", 0],
      ["adapter-one -> binding-one", 1],
      ["profile-one -> binding-one", 0],
    ]);
  });

  it("keeps core out of an adapter, and an adapter out of an edge", async () => {
    expect(
      await edges([
        ["core-one", "core", ["adapter-one"]],
        ["adapter-one", "adapter", ["edge-one"]],
        ["edge-one", "edge", ["core-one"]],
      ]),
    ).toStrictEqual([
      ["core-one -> adapter-one", 1],
      ["adapter-one -> edge-one", 1],
      ["edge-one -> core-one", 0],
    ]);
  });

  it("lets a profile reach every layer and a composition reach anything", async () => {
    const measured = await edges([
      ["profile-one", "profile", ["adapter-one", "edge-one", "core-one"]],
      ["composition-one", "composition", ["profile-one", "tooling-one"]],
      ["adapter-one", "adapter"],
      ["edge-one", "edge"],
      ["core-one", "core"],
      ["tooling-one", "tooling"],
    ]);

    expect(measured.map(([, value]) => value)).toStrictEqual([0, 0, 0, 0, 0]);
  });

  it("does not treat a third-party dependency as an edge", async () => {
    expect(await edges([["core-one", "core", ["zod"]]])).toStrictEqual([]);
  });

  it("stops on a package without a recognized kind", () => {
    expect(() => kindInversionsSignal.run(contextOver([["core-one", undefined]]))).toThrow(/declares kind undefined/u);
    expect(() => kindInversionsSignal.run(contextOver([["core-one", "library"]]))).toThrow(/declares kind "library"/u);
  });
});

it("checks a public optional binding under its own kind", async () => {
  const path = "packages/flags/package.json";
  const manifest = JSON.stringify({
    exports: {
      "./postgres": {
        types: "./dist/postgres/index.d.ts",
        default: "./dist/postgres/index.js",
      },
    },
    dadsBindings: { postgres: ["postgres"] },
    peerDependencies: { postgres: "1.0.0" },
    peerDependenciesMeta: { postgres: { optional: true } },
  });
  const base = contextOver([
    ["flags", "core", ["contract", "postgres"]],
    ["contract", "core"],
    ["postgres", "adapter"],
  ]);
  const context: DoctorContext = {
    ...base,
    exists: (file) => base.exists(file) || file === path || file === "packages/flags/src/postgres/index.ts",
    read: (file) => (file === path ? manifest : base.read(file)),
  };

  const readings = await kindInversionsSignal.run(context);

  expect([...readings.keys()]).toEqual(["flags -> contract", "flags/postgres -> postgres"]);
  expect(readings.get("flags/postgres -> postgres")?.value).toBe(0);
});
