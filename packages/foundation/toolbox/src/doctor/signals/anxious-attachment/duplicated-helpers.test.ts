/**
 * The same helper, written again, counted per package.
 *
 * Two packages that each declare `isRecord` have a naming coincidence; two
 * files in one package have a duplicate. That is why the key is the package
 * and the file is the unit — an overload pair in one file is still one file —
 * and why an app is a package root of its own. Tests, generated modules, test
 * support and type tests are not what a package ships, so a helper written
 * twice there is not the failure this signal is about.
 */

import { describe, expect, it } from "vitest";
import type { DoctorContext } from "../../doctor-context.js";
import {
  isProductionTypeScript,
  packageRootOf,
} from "../scanners/source-classification.js";
import { topLevelFunctionNames } from "../scanners/top-level-declarations.js";
import { duplicatedHelpersSignal } from "./duplicated-helpers.js";

function contextOver(tree: Record<string, string>): DoctorContext {
  return {
    root: "/repo",
    today: undefined,
    files: () => Object.keys(tree).sort(),
    directories: () => [],
    read: (path) => tree[path] ?? "",
    exists: (path) => tree[path] !== undefined,
    packages: () => [],
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

async function counted(
  tree: Record<string, string>,
): Promise<Record<string, number>> {
  const measured = await duplicatedHelpersSignal.run(contextOver(tree));
  return Object.fromEntries(
    [...measured].map(([key, reading]) => [key, reading.value]),
  );
}

const IS_RECORD = "export function isRecord(value) { return true; }\n";

describe("duplicated helpers", () => {
  it("counts the same name in two files of one package as two, in one as one", async () => {
    expect(
      await counted({
        "packages/http/core/src/one.ts": IS_RECORD,
        "packages/http/core/src/two.ts": IS_RECORD,
        "packages/testing/core/src/one.ts": IS_RECORD,
      }),
    ).toStrictEqual({
      "packages/http/core:isRecord": 2,
      "packages/testing/core:isRecord": 1,
    });
  });

  it("counts an app as a package root of its own", async () => {
    expect(
      await counted({
        "apps/workbench/src/one.ts": IS_RECORD,
        "packages/http/core/src/one.ts": IS_RECORD,
      }),
    ).toStrictEqual({
      "apps/workbench:isRecord": 1,
      "packages/http/core:isRecord": 1,
    });
  });

  it("counts an overload pair in one file once", async () => {
    expect(
      await counted({
        "packages/http/core/src/one.ts": [
          "export function parse(value: string): number;",
          "export function parse(value: number): number;",
          "export function parse(value: unknown): number { return 1; }",
        ].join("\n"),
      }),
    ).toStrictEqual({ "packages/http/core:parse": 1 });
  });

  it("asks only what a package ships", () => {
    expect(isProductionTypeScript("packages/http/core/src/one.ts")).toBe(true);
    expect(isProductionTypeScript("apps/workbench/src/one.ts")).toBe(true);
    expect(isProductionTypeScript("packages/http/core/src/one.test.ts")).toBe(
      false,
    );
    expect(
      isProductionTypeScript("packages/http/core/src/one.generated.ts"),
    ).toBe(false);
    expect(
      isProductionTypeScript("packages/http/core/type-tests/cards.ts"),
    ).toBe(false);
    expect(isProductionTypeScript("scripts/checks/check-docs.mjs")).toBe(false);
    expect(packageRootOf("packages/http/core/src/one.ts")).toBe(
      "packages/http/core",
    );
    expect(packageRootOf("apps/workbench/src/one.ts")).toBe("apps/workbench");
  });

  it("declares only a top-level function statement", () => {
    const text = [
      "export function outer() {",
      "  function inner() { return 1; }",
      "  return inner();",
      "}",
      "const arrow = function named() { return 2; };",
      "// function commented() {}",
      "export function second() { return 3; }",
    ].join("\n");

    expect([...topLevelFunctionNames(text)]).toStrictEqual(["outer", "second"]);
  });
});
