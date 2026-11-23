/**
 * What: a thrown value becomes a type, a message, and a grouping key that does
 * not move when the fault has not.
 * Why: the fingerprint is what turns "we had 400 errors" into "we had two
 * bugs". Every case below is a way that could quietly stop being true — a
 * message that varies per occurrence, a reformat that shifts a column, a
 * dependency frame that looks identical across unrelated faults.
 */

import { describe, expect, it } from "vitest";

import { describeException } from "./describe-exception.js";

function errorWith(name: string, message: string, stack: string[]): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = [`${name}: ${message}`, ...stack].join("\n");
  return error;
}

const OUR_FRAMES = [
  "    at createOrder (/app/apps/service/domains/orders/server/src/lib/mutations/create-order.mutation.js:88:15)",
  "    at buildRouteHandler (/app/packages/server/http/src/lib/request-pipeline/register-routes.js:190:22)",
];

describe("describeException", () => {
  it("reads the type, message and stack off an error", () => {
    const described = describeException(errorWith("DomainError", "Order company not found", OUR_FRAMES));

    expect(described.type).toBe("DomainError");
    expect(described.message).toBe("Order company not found");
    expect(described.stack).toContain("create-order.mutation");
  });

  it("groups by type and origin, never by message", () => {
    // "order 12345 not found" and "order 67890 not found" are one bug.
    const first = describeException(errorWith("DomainError", "order 12345 not found", OUR_FRAMES));
    const second = describeException(errorWith("DomainError", "order 67890 not found", OUR_FRAMES));

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("separates the same error type thrown from different places", () => {
    const here = describeException(errorWith("TypeError", "x", OUR_FRAMES));
    const elsewhere = describeException(
      errorWith("TypeError", "x", [
        "    at listScales (/app/apps/service/domains/scales/server/src/lib/queries/list-scales.js:12:3)",
      ]),
    );

    expect(here.fingerprint).not.toBe(elsewhere.fingerprint);
  });

  it("counts a bundled frame, because a bundle has no dependency paths", () => {
    // The production image is one `main.cjs`: every frame points at the
    // bundle and none says `node_modules`. A positive in-repository test
    // would have nothing to compare against there, so the rule is exclusion —
    // and this pins that a bundled frame is treated as ours.
    const bundled = describeException(
      errorWith("TypeError", "x", ["    at createOrder (/app/dist/apps/api/server/main.cjs:90210:15)"]),
    );
    const alsoBundled = describeException(
      errorWith("TypeError", "x", ["    at createOrder (/app/dist/apps/api/server/main.cjs:90210:41)"]),
    );

    expect(bundled.fingerprint).toBe(alsoBundled.fingerprint);
    expect(bundled.fingerprint).not.toBe(describeException(errorWith("TypeError", "x", OUR_FRAMES)).fingerprint);
  });

  it("ignores dependency and node frames when grouping", () => {
    // Two different faults share the framework frames underneath them; a
    // fingerprint built from those would merge unrelated bugs.
    const withNoise = describeException(
      errorWith("TypeError", "x", [
        "    at Object.query (/app/node_modules/pg/lib/client.js:500:1)",
        "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
        ...OUR_FRAMES,
      ]),
    );
    const withoutNoise = describeException(errorWith("TypeError", "x", OUR_FRAMES));

    expect(withNoise.fingerprint).toBe(withoutNoise.fingerprint);
  });

  it("survives a reformat that moves a column", () => {
    const before = describeException(errorWith("TypeError", "x", OUR_FRAMES));
    const afterPrettier = describeException(
      errorWith("TypeError", "x", [
        "    at createOrder (/app/apps/service/domains/orders/server/src/lib/mutations/create-order.mutation.js:88:41)",
        "    at buildRouteHandler (/app/packages/server/http/src/lib/request-pipeline/register-routes.js:190:7)",
      ]),
    );

    expect(before.fingerprint).toBe(afterPrettier.fingerprint);
  });

  it("notices when the fault moves to a different line", () => {
    const before = describeException(errorWith("TypeError", "x", OUR_FRAMES));
    const afterEdit = describeException(
      errorWith("TypeError", "x", [
        "    at createOrder (/app/apps/service/domains/orders/server/src/lib/mutations/create-order.mutation.js:142:15)",
        ...OUR_FRAMES.slice(1),
      ]),
    );

    expect(before.fingerprint).not.toBe(afterEdit.fingerprint);
  });

  it("describes a thrown non-error without inventing a message", () => {
    // Stringifying an arbitrary throw is how a payload reaches a log line.
    const described = describeException({ secret: "customer-private-value" });

    expect(described.type).toBe("object");
    expect(described.message).toBe("");
    expect(described.stack).toBeUndefined();
    expect(JSON.stringify(described)).not.toContain("customer-private-value");
  });

  it("reads a thrown string as its own message", () => {
    expect(describeException("boom").message).toBe("boom");
  });

  it("gives a stackless error a fingerprint anyway", () => {
    const stackless = new Error("no stack here");
    delete stackless.stack;

    expect(describeException(stackless).fingerprint).toHaveLength(8);
  });
});
