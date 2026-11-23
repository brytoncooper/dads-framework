/**
 * The pawl: `--base <ref>` against a baseline somebody edited by hand.
 *
 * Every local write moves toward the threshold, so the only way a number gets
 * worse is an edit, and the only thing that catches an edit is a comparison
 * with what was committed. These are the six ways the comparison fails and the
 * two ways it does not: a new exception is a reviewer's decision, and a mark
 * that came down is the point of the exercise.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadAtRef } from "./doctor-gate-base.js";
import { serializeBaseline } from "./doctor-gate-baseline.js";
import { BASELINE_PATH, SUPPRESSIONS_PATH, type BaselineSections, type GateMode } from "./doctor-gate-model.js";
import { runDoctorGate, type GateResult } from "./doctor-gate.js";

const BASE = "origin/main";
const SEEDED = "seeded before the gate existed";

type Entries = Record<string, { value: number; reason?: string; movedTo?: string }>;

function sections(raw: Record<string, Entries>): BaselineSections {
  return new Map(
    Object.entries(raw).map(([name, entries]) => [
      name,
      new Map(
        Object.entries(entries).map(([key, entry]) => [
          key,
          { value: entry.value, reason: entry.reason, movedTo: entry.movedTo },
        ]),
      ),
    ]),
  );
}

function baselineText(ceilings: Record<string, Entries>, floors: Record<string, Entries> = {}): string {
  return serializeBaseline({
    countedLines: "non-blank, non-comment",
    exempt: [],
    ceilings: sections(ceilings),
    floors: sections(floors),
  });
}

function marks(entries: Entries): Record<string, Entries> {
  return { fileLines: entries };
}

function floors(entries: Entries): Record<string, Entries> {
  return { soundnessCases: entries };
}

const BASE_MODE: GateMode = {
  json: false,
  update: false,
  seed: false,
  report: false,
  profile: "standard",
  files: undefined,
  base: BASE,
  today: undefined,
  reason: undefined,
  key: undefined,
};

/** What each file looked like at each ref, and nothing else. */
function atRefs(contents: Record<string, string>): ReadAtRef {
  return (ref, path) => {
    const stored = contents[`${ref}:${path}`];
    return stored === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: stored };
  };
}

async function compare(current: string, readAtRef: ReadAtRef): Promise<GateResult> {
  const root = mkdtempSync(join(tmpdir(), "dad-gate-base-"));
  try {
    mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
    writeFileSync(join(root, BASELINE_PATH), current);
    return await runDoctorGate({
      root,
      mode: BASE_MODE,
      signals: [],
      readAtRef,
      write: () => {
        throw new Error("--base only reads.");
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One floor section now against the same one at the ref. */
async function moved(current: Entries, base: Entries): Promise<GateResult> {
  return compare(
    baselineText({}, floors(current)),
    atRefs({ [`${BASE}:${BASELINE_PATH}`]: baselineText({}, floors(base)) }),
  );
}

describe("--base", () => {
  it("rejects a mark raised by hand", async () => {
    const result = await compare(
      baselineText(marks({ "src/a.ts": { value: 900, reason: SEEDED } })),
      atRefs({
        [`${BASE}:${BASELINE_PATH}`]: baselineText(marks({ "src/a.ts": { value: 712, reason: SEEDED } })),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/mark rose 712 -> 900/);
  });

  it("rejects a lowered floor and a removed floor entry", async () => {
    const previous = baselineText(
      {},
      floors({
        cases: { value: 21, reason: SEEDED },
        extra: { value: 5, reason: SEEDED },
      }),
    );

    const lowered = await compare(
      baselineText(
        {},
        floors({
          cases: { value: 18, reason: SEEDED },
          extra: { value: 5, reason: SEEDED },
        }),
      ),
      atRefs({ [`${BASE}:${BASELINE_PATH}`]: previous }),
    );
    expect(lowered.exitCode).toBe(1);
    expect(lowered.output).toMatch(/floor fell 21 -> 18/);

    const removed = await compare(
      baselineText({}, floors({ cases: { value: 21, reason: SEEDED } })),
      atRefs({ [`${BASE}:${BASELINE_PATH}`]: previous }),
    );
    expect(removed.exitCode).toBe(1);
    expect(removed.output).toMatch(/floor entry removed \(was 5\)/);
  });

  it("rejects an entry that lost its reason", async () => {
    const result = await compare(
      baselineText(marks({ "src/a.ts": { value: 712 } })),
      atRefs({
        [`${BASE}:${BASELINE_PATH}`]: baselineText(marks({ "src/a.ts": { value: 712, reason: SEEDED } })),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/has no reason/);
  });

  it("lists new exceptions without failing, and a lowered mark is fine", async () => {
    const result = await compare(
      baselineText(
        marks({
          "src/a.ts": { value: 600, reason: SEEDED },
          "src/new.ts": { value: 450, reason: "split lands next week" },
        }),
      ),
      atRefs({
        [`${BASE}:${BASELINE_PATH}`]: baselineText(marks({ "src/a.ts": { value: 712, reason: SEEDED } })),
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/new exceptions since origin\/main:/);
    expect(result.output).toMatch(/fileLines src\/new\.ts: mark 450 \(split lands next week\)/);
  });

  it("treats every entry as new when the ref carries no baseline", async () => {
    const result = await compare(baselineText(marks({ "src/a.ts": { value: 712, reason: SEEDED } })), atRefs({}));

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/does not exist at origin\/main/);
    expect(result.output).toMatch(/new exceptions since origin\/main:/);
  });

  it("rejects a floor that fell with no movedTo", async () => {
    const result = await moved(
      { a: { value: 4, reason: SEEDED }, b: { value: 27, reason: SEEDED } },
      { a: { value: 27, reason: SEEDED }, b: { value: 4, reason: SEEDED } },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/floor fell 27 -> 4 with no movedTo/);
  });

  it("rejects an eslint-suppressions.json that grew", async () => {
    const result = await compare(
      baselineText({}),
      atRefs({
        [`${BASE}:${BASELINE_PATH}`]: baselineText({}),
        [`${BASE}:${SUPPRESSIONS_PATH}`]: JSON.stringify({
          "src/a.ts": { complexity: { count: 2 } },
        }),
        [`HEAD:${SUPPRESSIONS_PATH}`]: JSON.stringify({
          "src/a.ts": { complexity: { count: 3 } },
        }),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/eslint-suppressions\.json: suppressions grew 2 -> 3/);
  });
});

/**
 * The one fall that is not a loosening: a package split, declared in the diff
 * that made it. `movedTo` names the key the count went to, and the pawl does
 * the arithmetic itself rather than reading the sentence beside it.
 */
describe("--base, when a floor's count moves to another key", () => {
  const MOVED = "23 tests moved to b when the package was split";

  it("allows the fall when the named key rose by at least as much", async () => {
    const result = await moved(
      {
        a: { value: 4, reason: MOVED, movedTo: "b" },
        b: { value: 27, reason: SEEDED },
      },
      { a: { value: 27, reason: SEEDED }, b: { value: 4, reason: SEEDED } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/floors moved since origin\/main:/);
    expect(result.output).toMatch(/soundnessCases a: floor moved 23 to b \(which rose 23\)/);
  });

  it("counts a key the ref does not carry as zero", async () => {
    const result = await moved(
      {
        a: { value: 4, reason: MOVED, movedTo: "b" },
        b: { value: 23, reason: SEEDED },
      },
      { a: { value: 27, reason: SEEDED } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/floor moved 23 to b \(which rose 23\)/);
  });

  it("rejects the fall when the named key rose too little", async () => {
    const result = await moved(
      {
        a: { value: 4, reason: MOVED, movedTo: "b" },
        b: { value: 16, reason: SEEDED },
      },
      { a: { value: 27, reason: SEEDED }, b: { value: 4, reason: SEEDED } },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/floor fell 27 -> 4 with movedTo b, which rose 12, not 23/);
  });

  it("rejects an entry that names itself", async () => {
    const result = await moved(
      {
        a: { value: 4, reason: MOVED, movedTo: "a" },
        b: { value: 27, reason: SEEDED },
      },
      { a: { value: 27, reason: SEEDED }, b: { value: 4, reason: SEEDED } },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/movedTo names its own key/);
  });

  it("rejects a key this section does not record, fall or no fall", async () => {
    const fell = await moved(
      {
        a: { value: 4, reason: MOVED, movedTo: "gone" },
        b: { value: 27, reason: SEEDED },
      },
      { a: { value: 27, reason: SEEDED }, b: { value: 4, reason: SEEDED } },
    );
    expect(fell.exitCode).toBe(1);
    expect(fell.output).toMatch(/movedTo names gone, which is not a key in this section/);
    expect(fell.output).toMatch(/floor fell 27 -> 4 with movedTo gone, which the baseline does not record/);

    const stood = await moved(
      { a: { value: 27, reason: MOVED, movedTo: "gone" } },
      { a: { value: 27, reason: SEEDED } },
    );
    expect(stood.exitCode).toBe(1);
    expect(stood.output).toMatch(/movedTo names gone, which is not a key in this section/);
  });

  it("rejects the fall when the entry lost the reason for it", async () => {
    const result = await moved(
      { a: { value: 4, movedTo: "b" }, b: { value: 27, reason: SEEDED } },
      { a: { value: 27, reason: SEEDED }, b: { value: 4, reason: SEEDED } },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/floor fell 27 -> 4 with no reason on the entry/);
  });

  it("ignores the receipt once the fall it explains is in the past", async () => {
    const settled: Entries = {
      a: { value: 4, reason: MOVED, movedTo: "b" },
      b: { value: 27, reason: SEEDED },
    };

    const result = await moved(settled, settled);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(/floors moved since/);
  });
});
