/**
 * The ratchet's own rule, as the history reads it.
 *
 * `marks-raised-in-history` walks committed revisions and asks one question per
 * pair: did this number move the way the ratchet forbids? A floor that fell is
 * that move unless the same revision says where its count went, so the receipt
 * is read here with the entry and the arithmetic is checked here too. The
 * corpus proves the walk; these are the branches of the one exception.
 */

import { describe, expect, it } from "vitest";
import {
  isLoosening,
  readBaselineEntries,
  transferCoversFall,
  type BaselineEntry,
} from "./ratchet-baseline-history.js";

const REASON = "23 cases moved to b on 2026-09-07";

type Written = { floor: number; reason?: string; movedTo?: string };

/** One revision of the baseline, as a document rather than as a map. */
function revision(floors: Record<string, Written>): ReadonlyMap<string, BaselineEntry> {
  return readBaselineEntries(JSON.stringify({ ceilings: {}, floors: { testCount: floors } }));
}

function entryOf(entries: ReadonlyMap<string, BaselineEntry>, key: string): BaselineEntry {
  const entry = entries.get(key);
  if (entry === undefined) throw new Error(`${key} is not recorded.`);
  return entry;
}

describe("a floor that fell between two revisions", () => {
  const earlier = revision({ a: { floor: 27 }, b: { floor: 4 } });

  it("is a loosening the file says nothing about", () => {
    const later = revision({ a: { floor: 4 }, b: { floor: 27 } });
    const fell = entryOf(later, "floors/testCount/a");

    expect(isLoosening(27, 4, fell.section)).toBe(true);
    expect(transferCoversFall(fell, 23, later, earlier)).toBe(false);
  });

  it("is a move when the key it names rose by at least the fall", () => {
    const later = revision({
      a: { floor: 4, movedTo: "b", reason: REASON },
      b: { floor: 27 },
    });
    const fell = entryOf(later, "floors/testCount/a");

    expect(fell.movedTo).toBe("floors/testCount/b");
    expect(transferCoversFall(fell, 23, later, earlier)).toBe(true);
    expect(transferCoversFall(fell, 24, later, earlier)).toBe(false);
  });

  it("counts a key the earlier revision did not record as zero", () => {
    const later = revision({
      a: { floor: 4, movedTo: "b", reason: REASON },
      b: { floor: 23 },
    });
    const fell = entryOf(later, "floors/testCount/a");

    expect(transferCoversFall(fell, 23, later, revision({ a: { floor: 27 } }))).toBe(true);
  });

  it("is a loosening when the receipt names itself, or a key nobody records", () => {
    const itself = revision({
      a: { floor: 4, movedTo: "a", reason: REASON },
      b: { floor: 27 },
    });
    const elsewhere = revision({
      a: { floor: 4, movedTo: "gone", reason: REASON },
      b: { floor: 27 },
    });

    expect(transferCoversFall(entryOf(itself, "floors/testCount/a"), 23, itself, earlier)).toBe(false);
    expect(transferCoversFall(entryOf(elsewhere, "floors/testCount/a"), 23, elsewhere, earlier)).toBe(false);
  });

  it("is a loosening when the entry never said why", () => {
    const later = revision({ a: { floor: 4, movedTo: "b" }, b: { floor: 27 } });

    expect(transferCoversFall(entryOf(later, "floors/testCount/a"), 23, later, earlier)).toBe(false);
  });
});

/** A mark is the one number a split cannot move: the file it names is still there. */
describe("a ceiling that rose", () => {
  const marks = (a: Record<string, unknown>, b: number): ReadonlyMap<string, BaselineEntry> =>
    readBaselineEntries(
      JSON.stringify({
        ceilings: {
          fileLines: { "src/a.ts": a, "src/b.ts": { mark: b, reason: REASON } },
        },
        floors: {},
      }),
    );

  it("never transfers, whatever the entry beside it says", () => {
    const raised = marks({ mark: 420, movedTo: "src/b.ts", reason: REASON }, 900);
    const before = marks({ mark: 410, reason: REASON }, 10);
    const rose = entryOf(raised, "ceilings/fileLines/src/a.ts");

    expect(isLoosening(410, 420, rose.section)).toBe(true);
    expect(transferCoversFall(rose, -10, raised, before)).toBe(false);
  });
});
