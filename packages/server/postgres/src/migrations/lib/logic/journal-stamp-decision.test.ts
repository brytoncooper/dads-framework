// The leftover-Drizzle cutover stamp is a one-shot shim: a live journal or an
// empty public schema must never pay for a catalog compare.
import { describe, expect, it } from "vitest";
import { journalStampDecision } from "./journal-stamp-decision.js";

describe("journalStampDecision", () => {
  it("skips when any node-pg migration is already recorded", () => {
    expect(journalStampDecision({ appliedCount: 1, publicTableCount: 40 })).toBe("skip");
  });

  it("skips an empty public schema so a fresh database applies normally", () => {
    expect(journalStampDecision({ appliedCount: 0, publicTableCount: 0 })).toBe("skip");
  });

  it("offers the shim only for an unjournaled leftover schema", () => {
    expect(journalStampDecision({ appliedCount: 0, publicTableCount: 40 })).toBe("stamp-if-equivalent");
  });
});
