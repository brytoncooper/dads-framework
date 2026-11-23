/**
 * What: a thrown value becomes a name, a message, located frames, and a
 * grouping key that does not move.
 * Why: this is the only place in the client that reads a stack, so it is the
 * only place that can leak one. Two of the cases below are privacy rules
 * (no query strings in a frame, nothing stringified out of an unknown throw)
 * and two are grouping rules — a fingerprint that changed with the message
 * would make every occurrence of a fault its own issue.
 */

import { describe, expect, it } from "vitest";

import { describeClientError } from "./describe-client-error.js";

function errorWithStack(name: string, message: string, stack: string): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

const STACK = [
  "TypeError: cannot read properties of undefined",
  "    at OrderTable (https://app.example/assets/orders-a1b2.js:42:17)",
  "    at renderWithHooks (https://app.example/assets/react-c3d4.js:118:22)",
  "    at https://app.example/assets/main-e5f6.js:9:3",
].join("\n");

describe("describeClientError", () => {
  it("reads the name, message and located frames off an error", () => {
    const described = describeClientError(
      errorWithStack("TypeError", "cannot read properties of undefined", STACK),
    );

    expect(described.name).toBe("TypeError");
    expect(described.message).toBe("cannot read properties of undefined");
    expect(described.frames[0]).toEqual({
      function: "OrderTable",
      file: "https://app.example/assets/orders-a1b2.js",
      line: 42,
      column: 17,
    });
  });

  it("reads a frame that has no function name", () => {
    const described = describeClientError(
      errorWithStack("TypeError", "x", STACK),
    );

    expect(described.frames[2]).toEqual({
      file: "https://app.example/assets/main-e5f6.js",
      line: 9,
      column: 3,
    });
  });

  it("strips a query string off a frame's file", () => {
    // A bundle url can carry whatever a router put in the query. The asset
    // path is what symbolication needs; the rest is not ours to ship.
    const described = describeClientError(
      errorWithStack(
        "Error",
        "x",
        "Error: x\n    at boot (https://app.example/assets/main.js?token=private-value:1:1)",
      ),
    );

    expect(JSON.stringify(described.frames)).not.toContain("private-value");
  });

  it("groups by name and origin, never by message", () => {
    // "order 12345 not found" and "order 67890 not found" are one fault.
    const first = describeClientError(
      errorWithStack("TypeError", "order 12345 is missing", STACK),
    );
    const second = describeClientError(
      errorWithStack("TypeError", "order 67890 is missing", STACK),
    );

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("gives different faults different groups", () => {
    const here = describeClientError(errorWithStack("TypeError", "x", STACK));
    const elsewhere = describeClientError(
      errorWithStack(
        "TypeError",
        "x",
        "TypeError: x\n    at ScaleReadout (https://app.example/assets/scales-9z8y.js:7:1)",
      ),
    );

    expect(here.fingerprint).not.toBe(elsewhere.fingerprint);
  });

  it("survives a thrown non-error without inventing a message", () => {
    // Stringifying an arbitrary throw is how user data reaches a field.
    const described = describeClientError({ secret: "customer-private-value" });

    expect(described.message).toBe("");
    expect(described.frames).toEqual([]);
    expect(JSON.stringify(described)).not.toContain("customer-private-value");
  });

  it("reads a thrown string as its own message", () => {
    expect(describeClientError("boom").message).toBe("boom");
  });
});
