/**
 * What: transport failures become a message-free classification for the app
 * presenter.
 * Why: renderer edges may branch on stable codes and kinds, but must never
 * receive the server or JavaScript sentence as display copy.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, NetworkError, UnauthorizedError, readClientFailure } from "./api-error.js";

describe("readClientFailure", () => {
  it("retains stable API fields without exposing the raw message", () => {
    expect(
      readClientFailure(
        new ApiError(409, "REVISION_CONFLICT", "RAW_SERVER_MESSAGE", {
          currentRevision: 12,
        }),
      ),
    ).toEqual({
      kind: "api",
      status: 409,
      code: "REVISION_CONFLICT",
      details: { currentRevision: 12 },
    });
  });

  it("distinguishes session, network, and unexpected failures", () => {
    expect(readClientFailure(new UnauthorizedError("UNAUTHENTICATED", "RAW_SESSION_MESSAGE"))).toEqual({
      kind: "session-expired",
    });
    expect(readClientFailure(new NetworkError(new TypeError("offline")))).toMatchObject({ kind: "network" });
    expect(readClientFailure(new Error("RAW_JAVASCRIPT_MESSAGE"))).toMatchObject({ kind: "unexpected" });
  });

  it("keeps the original error for telemetry instead of dropping it", () => {
    // The hole this closes: every non-API throw used to collapse to
    // `unexpected` with nothing left to report. A render TypeError, a
    // chunk-load failure and a contract mismatch were indistinguishable.
    const thrown = new TypeError("cannot read properties of undefined");

    const failure = readClientFailure(thrown);

    expect(failure).toMatchObject({ kind: "unexpected" });
    expect(failure.kind === "unexpected" && failure.cause).toBe(thrown);
  });

  it("keeps what a network failure was actually caused by", () => {
    const offline = new TypeError("Failed to fetch");

    const failure = readClientFailure(new NetworkError(offline));

    expect(failure.kind === "network" && failure.cause).toBe(offline);
  });

  it("names a response that did not match the contract as drift", () => {
    // `api-verbs` parses every response against the contract the client was
    // compiled with, so a ZodError here means the two ends disagree about the
    // wire — a deployment problem, not a logic bug in either of them.
    const drifted = z.object({ data: z.object({ quantity: z.number() }) }).safeParse({ data: { quantity: "500" } });
    if (drifted.success) throw new Error("expected the fixture to fail");

    const failure = readClientFailure(drifted.error);

    expect(failure).toEqual({
      kind: "contract-drift",
      issues: [{ path: "data.quantity", code: "invalid_type" }],
    });
  });

  it("reports drift as paths and codes, never as an issue message", () => {
    // An issue MESSAGE is prose, and a custom refinement is free to compose it
    // from the value it rejected — as this fixture does, and as any contract
    // author may. A telemetry event must not carry that out of the browser, so
    // the classifier keeps the path and the code and nothing else.
    const drifted = z
      .object({
        reference: z.string().refine((value) => value.startsWith("PO-"), {
          message: "customer-private-value is not a purchase order",
        }),
      })
      .safeParse({ reference: "customer-private-value" });
    if (drifted.success) throw new Error("expected the fixture to fail");
    expect(drifted.error.issues[0]?.message).toContain("customer-private-value");

    const failure = readClientFailure(drifted.error);

    expect(failure).toMatchObject({ kind: "contract-drift" });
    expect(JSON.stringify(failure)).not.toContain("customer-private-value");
  });
});
