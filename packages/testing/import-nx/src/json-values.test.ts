import { describe, expect, it } from "vitest";
import { stableJson } from "./json-values.js";

/**
 * The manifest checksum is taken over `stableJson`'s bytes, so key order and
 * spacing are part of the contract rather than a formatting preference. If two
 * runs over equal data could produce different bytes, the checksum in the
 * import report would mean nothing.
 */

describe("stableJson", () => {
  it("produces identical bytes for equal data written in different key orders", () => {
    const first = stableJson({
      schemaVersion: 1,
      workspace: { root: ".", fullFallback: { taskIds: ["b", "a"] } },
      tasks: [{ id: "a", project: "p" }],
    });
    const second = stableJson({
      tasks: [{ project: "p", id: "a" }],
      workspace: { fullFallback: { taskIds: ["b", "a"] }, root: "." },
      schemaVersion: 1,
    });

    expect(first).toBe(second);
    expect(new TextEncoder().encode(first)).toEqual(
      new TextEncoder().encode(second),
    );
  });

  it("sorts every nested object key, keeps array order, and ends with one newline", () => {
    const serialized = stableJson({
      b: { d: 1, c: [{ z: 1, y: 2 }] },
      a: null,
    });

    expect(serialized).toBe(
      `{
  "a": null,
  "b": {
    "c": [
      {
        "y": 2,
        "z": 1
      }
    ],
    "d": 1
  }
}
`,
    );
  });

  it("refuses to serialize an output value JSON cannot round-trip", () => {
    for (const value of [undefined, () => "x", 0n, Symbol("x")]) {
      expect(() => stableJson({ importer: value })).toThrow(
        "Importer attempted to serialize a non-JSON output value.",
      );
    }
  });
});
