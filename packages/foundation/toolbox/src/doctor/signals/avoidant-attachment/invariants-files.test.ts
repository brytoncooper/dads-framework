/**
 * One floor per package, and which packages are asked at all.
 *
 * A shared count would let one package delete its invariants the same week
 * another wrote its first, so the reading is keyed per package. What is worth
 * pinning beyond that is who is asked: the packages and apps that ship
 * behavior, never the crates, the fixtures or the script tree, and an
 * `artifact` held at zero because a build product is not a place invariants
 * live. A package that does not say what it is stops the reading rather than
 * counting as zero.
 */

import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import { invariantsFilesSignal } from "./invariants-files.js";

function contextOver(
  packages: readonly DoctorPackage[],
  files: readonly string[],
  hasProjectFile = true,
): DoctorContext {
  return {
    root: "/repo",
    today: undefined,
    files: () => files,
    directories: () => [],
    read: () => "",
    exists: (path) => hasProjectFile && path === "dads.project.json",
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

function declared(
  name: string,
  root: string,
  kind: string | undefined,
): DoctorPackage {
  return { name, root, kind, allowedDependencies: [] };
}

async function readings(
  context: DoctorContext,
): Promise<Record<string, number>> {
  const measured = await invariantsFilesSignal.run(context);
  return Object.fromEntries(
    [...measured].map(([key, reading]) => [key, reading.value]),
  );
}

describe("the invariants floor", () => {
  it("gives a package under packages/ or apps/ one key, present or absent", async () => {
    const context = contextOver(
      [
        declared("@dads/http-core", "packages/http/core", "core"),
        declared("@dads-app/workbench", "apps/workbench", "app"),
      ],
      ["packages/http/core/INVARIANTS.md"],
    );

    expect(await readings(context)).toStrictEqual({
      "@dads/http-core": 1,
      "@dads-app/workbench": 0,
    });
  });

  it("asks no crate, fixture or script, and holds an artifact at zero", async () => {
    const context = contextOver(
      [
        declared("dads-testing-core", "crates/dads-testing-core", "engine"),
        declared("@dads/fixture", "fixtures/testing", "fixture"),
        declared("@dads/native", "packages/testing/native", "artifact"),
      ],
      ["packages/testing/native/INVARIANTS.md"],
    );

    expect(await readings(context)).toStrictEqual({ "@dads/native": 0 });
  });

  it("does not count a file nobody tracks", async () => {
    const context = contextOver(
      [declared("@dads/http-core", "packages/http/core", "core")],
      [],
    );

    expect(await readings(context)).toStrictEqual({ "@dads/http-core": 0 });
  });

  it("stops on a package that does not say what it is", () => {
    const context = contextOver(
      [declared("@dads/http-core", "packages/http/core", undefined)],
      [],
    );

    expect(() => invariantsFilesSignal.run(context)).toThrow(
      'package "@dads/http-core" declares no kind',
    );
  });

  it("measures nothing at all where no project file declares packages", async () => {
    const context = contextOver([], [], false);

    expect(await readings(context)).toStrictEqual({});
  });
});
