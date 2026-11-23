/**
 * What counts as impurity in a barrel.
 *
 * The count is taken from a skeleton of the source rather than from a pattern
 * over raw text, so the case worth writing down is the mixed barrel: a
 * re-export and a type-only re-export cost nothing, while an import, a
 * constant, and a local declaration are each one statement that hides behind
 * the public surface.
 */

import { describe, expect, it } from "vitest";
import { countImpureStatements } from "./barrel-impurity.js";

describe("barrel impurity", () => {
  it("counts everything that is not a re-export", () => {
    const mixed = [
      'export * from "./route.js";',
      'export type { RouteCard } from "./route-card.js";',
      'import { helper } from "./helper.js";',
      'export const VERSION = "1";',
      "export type Local = { id: string };",
    ].join("\n");
    const pure = ['export * from "./route.js";', 'export type { RouteCard } from "./route-card.js";'].join("\n");

    expect(countImpureStatements(mixed)).toBe(3);
    expect(countImpureStatements(pure)).toBe(0);
  });
});
