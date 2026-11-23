/**
 * What: the guard that turns a failed structure-tree read into "no tree".
 * Why: a PDF with a malformed structure tree must still open, instead of
 * throwing an uncaught error from inside pdf.js (pdf.js #19694, #19822).
 */
import { describe, expect, it } from "vitest";

import { guardStructTree, isStructTreeSource, type StructTreeSource } from "./pdf-struct-tree-guard.js";

describe("guardStructTree", () => {
  it("resolves null when the original rejects", async () => {
    const target: StructTreeSource = {
      getStructTree: () => Promise.reject(new TypeError("i.getRaw is not a function")),
    };
    guardStructTree(target);
    await expect(target.getStructTree()).resolves.toBeNull();
  });

  it("passes a resolved value through unchanged", async () => {
    const tree = { role: "Root", children: [] };
    const target: StructTreeSource = {
      getStructTree: () => Promise.resolve(tree),
    };
    guardStructTree(target);
    await expect(target.getStructTree()).resolves.toBe(tree);
  });

  it("wraps only once when applied twice", async () => {
    let calls = 0;
    const target: StructTreeSource = {
      getStructTree: () => {
        calls += 1;
        return Promise.resolve("tree");
      },
    };
    guardStructTree(target);
    const first = target.getStructTree;
    guardStructTree(target);
    expect(target.getStructTree).toBe(first);
    await target.getStructTree();
    expect(calls).toBe(1);
  });
});

describe("isStructTreeSource", () => {
  it("accepts an object with a callable getStructTree and rejects anything else", () => {
    expect(isStructTreeSource({ getStructTree: () => Promise.resolve() })).toBe(true);
    expect(isStructTreeSource({ getStructTree: "tree" })).toBe(false);
    expect(isStructTreeSource(null)).toBe(false);
    expect(isStructTreeSource("page")).toBe(false);
  });
});
