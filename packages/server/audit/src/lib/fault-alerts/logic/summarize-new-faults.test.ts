/**
 * What: only genuinely new fault types are worth an email, loudest first.
 * Why: this decides whether the alert channel is one people read or one they
 * filter. Too eager and it is noise; too quiet and nobody finds out, which is
 * the pain the whole initiative exists to end. Both failure modes are silent,
 * so each rule gets a test rather than a comment.
 */

import { describe, expect, it } from "vitest";

import type { FaultGroup } from "../../database/readers/fault-alert-reader.interface.js";
import {
  isWorthSending,
  MAX_FAULTS_PER_ALERT,
  summarizeNewFaults,
} from "./summarize-new-faults.js";

function group(overrides: Partial<FaultGroup> = {}): FaultGroup {
  return {
    fingerprint: "a1b2c3d4",
    type: "TypeError",
    occurrences: 1,
    where: "/api/orders",
    ...overrides,
  };
}

describe("summarizeNewFaults", () => {
  it("carries both origins, marked", () => {
    const summary = summarizeNewFaults({
      server: [group({ fingerprint: "server01" })],
      client: [group({ fingerprint: "client01", type: "render" })],
    });

    expect(summary.faults.map((fault) => fault.origin)).toEqual([
      "server",
      "client",
    ]);
  });

  it("puts the loudest fault first", () => {
    // A new fault that has already happened two hundred times is a different
    // conversation from one that happened once.
    const summary = summarizeNewFaults({
      server: [
        group({ fingerprint: "quiet", occurrences: 1 }),
        group({ fingerprint: "loud", occurrences: 204 }),
      ],
      client: [group({ fingerprint: "middling", occurrences: 30 })],
    });

    expect(summary.faults.map((fault) => fault.fingerprint)).toEqual([
      "loud",
      "middling",
      "quiet",
    ]);
  });

  it("totals every occurrence, including the ones it trimmed", () => {
    const many = Array.from({ length: MAX_FAULTS_PER_ALERT + 5 }, (_, at) =>
      group({ fingerprint: `fault-${at}`, occurrences: 2 }),
    );

    const summary = summarizeNewFaults({ server: many, client: [] });

    expect(summary.faults).toHaveLength(MAX_FAULTS_PER_ALERT);
    expect(summary.truncated).toBe(true);
    // The count is the truth even when the list is not.
    expect(summary.totalOccurrences).toBe((MAX_FAULTS_PER_ALERT + 5) * 2);
  });

  it("does not claim truncation when everything fit", () => {
    const summary = summarizeNewFaults({ server: [group()], client: [] });

    expect(summary.truncated).toBe(false);
  });
});

describe("isWorthSending", () => {
  it("sends when something new happened", () => {
    expect(
      isWorthSending(summarizeNewFaults({ server: [group()], client: [] })),
    ).toBe(true);
  });

  it("stays quiet when nothing did", () => {
    // An email saying "nothing broke" every hour is how a channel dies, and a
    // dead channel is indistinguishable from no channel at all.
    expect(isWorthSending(summarizeNewFaults({ server: [], client: [] }))).toBe(
      false,
    );
  });
});
