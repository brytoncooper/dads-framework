/**
 * The states of the gate, over a repository that exists only for the test.
 *
 * These are the behaviours the source-budget ratchet pinned before the doctor
 * owned it, moved here whole: a ceiling only ever turns down, a floor only ever
 * goes up, an exception carries a reason, `--update` records nothing it was not
 * already holding, and `--seed` adds without touching what it already knows.
 * The signals are fakes with fixed readings, so what is under test is the
 * judgement and not the measurement — the corpus proves the measurements.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeBaseline } from "./doctor-gate-baseline.js";
import { BASELINE_PATH, type BaselineSections, type GateMode } from "./doctor-gate-model.js";
import { baselineSectionOf, gatedSignals, runDoctorGate, type GateResult } from "./doctor-gate.js";
import { countedReading, type DoctorSignal } from "./doctor-signal.js";

const TODAY = "2026-09-04";
const SEEDED = "seeded before the gate existed";

// ---------------------------------------------------------------------------
// The world one run sees
// ---------------------------------------------------------------------------

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

function baselineText(ceilings: Record<string, Entries>, floors: Record<string, Entries>): string {
  return serializeBaseline({
    countedLines: "non-blank, non-comment",
    exempt: ["**/*.generated.ts", "**/dist/**"],
    ceilings: sections(ceilings),
    floors: sections(floors),
  });
}

function gateMode(overrides: Partial<GateMode>): GateMode {
  return {
    json: false,
    update: false,
    seed: false,
    report: false,
    profile: "standard",
    files: undefined,
    base: undefined,
    today: undefined,
    reason: undefined,
    key: undefined,
    ...overrides,
  };
}

/** A ceiling signal whose readings are given rather than measured. */
function ceiling(
  values: Record<string, number>,
  options: {
    id?: string;
    measure?: string | undefined;
    threshold?: number | null;
    unit?: DoctorSignal["unit"];
  } = {},
): DoctorSignal {
  const standard = options.threshold === undefined ? 400 : options.threshold;
  return {
    id: options.id ?? "files-over-ceiling",
    issue: "enmeshment",
    question: "A ceiling under test?",
    reads: "text",
    unit: options.unit ?? "lines",
    direction: "ceiling",
    thresholds: { standard, strict: 400 },
    sentence: "A ceiling under test.",
    ...(options.measure === undefined ? {} : { measure: options.measure }),
    run: () => Promise.resolve(readingsOf(values)),
  };
}

/** A floor signal whose readings are given rather than measured. */
function floor(values: Record<string, number>, options: { id?: string; measure?: string } = {}): DoctorSignal {
  return {
    id: options.id ?? "soundness-cases",
    issue: "commitment-issues",
    question: "A floor under test?",
    reads: "text",
    unit: "count",
    direction: "floor",
    thresholds: { standard: null, strict: null },
    sentence: "A floor under test.",
    measure: options.measure ?? "soundnessCases",
    run: () => Promise.resolve(readingsOf(values)),
  };
}

function readingsOf(values: Record<string, number>) {
  return new Map(Object.entries(values).map(([key, value]) => [key, countedReading(value)]));
}

const FILE_LINES = { measure: "fileLines" };

type GateRun = {
  readonly mode: Partial<GateMode>;
  readonly signals: readonly DoctorSignal[];
  readonly ceilings?: Record<string, Entries>;
  readonly floors?: Record<string, Entries>;
  readonly tree?: Record<string, string>;
};

type GateOutput = {
  readonly result: GateResult;
  readonly written: ReadonlyMap<string, string>;
};

/** Runs one gate over a temporary repository, capturing what it would write. */
async function runGate(run: GateRun): Promise<GateOutput> {
  const root = mkdtempSync(join(tmpdir(), "dad-gate-"));
  try {
    const tree: Record<string, string> = {
      [BASELINE_PATH]: baselineText(run.ceilings ?? {}, run.floors ?? {}),
      ...run.tree,
    };
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const written = new Map<string, string>();
    const result = await runDoctorGate({
      root,
      mode: gateMode(run.mode),
      signals: run.signals,
      write: (path, text) => written.set(path, text),
    });
    return { result, written };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Ceiling states
// ---------------------------------------------------------------------------

describe("a ceiling key", () => {
  it("passes when it is unlisted and under the threshold", async () => {
    const { result } = await runGate({
      mode: {},
      signals: [ceiling({ "src/a.ts": 120 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/0 errors, 0 warnings/);
  });

  it("fails when it is unlisted and over, and --update never records it", async () => {
    const { result, written } = await runGate({
      mode: { update: true },
      signals: [ceiling({ "src/a.ts": 401 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/401 lines over the 400 ceiling and not listed/);
    expect(result.baseline.ceilings.get("fileLines")).toBeUndefined();
    expect(written.size).toBe(0);
  });

  it("warns and does not fail while it sits at its mark", async () => {
    const { result } = await runGate({
      mode: {},
      ceilings: { fileLines: { "src/a.ts": { value: 712, reason: SEEDED } } },
      signals: [ceiling({ "src/a.ts": 712 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/712 lines at its mark \(ceiling 400, delta 0\)/);
  });

  it("fails when it rises above its mark", async () => {
    const { result } = await runGate({
      mode: {},
      ceilings: { fileLines: { "src/a.ts": { value: 712, reason: SEEDED } } },
      signals: [ceiling({ "src/a.ts": 715 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/above its mark 712 \(\+3\)/);
  });

  it("fails below its mark in check mode and is lowered by --update", async () => {
    const listed = {
      fileLines: { "src/a.ts": { value: 712, reason: SEEDED } },
    };
    const signals = [ceiling({ "src/a.ts": 692 }, FILE_LINES)];

    const checked = await runGate({ mode: {}, ceilings: listed, signals });
    expect(checked.result.exitCode).toBe(1);
    expect(checked.result.output).toMatch(/mark can be lowered, run npm run budgets:update/);
    expect(checked.written.size).toBe(0);

    const updated = await runGate({
      mode: { update: true },
      ceilings: listed,
      signals,
    });
    expect(updated.result.exitCode).toBe(0);
    expect(updated.result.output).toMatch(/mark lowered 712 -> 692 \(-20\)/);
    expect(updated.result.baseline.ceilings.get("fileLines")?.get("src/a.ts")).toStrictEqual({
      value: 692,
      reason: SEEDED,
    });
    expect(updated.written.get(BASELINE_PATH)).toMatch(/"mark": 692/);
  });

  it("loses its entry once it is back under the ceiling", async () => {
    const listed = {
      fileLines: { "src/a.ts": { value: 712, reason: SEEDED } },
    };
    const signals = [ceiling({ "src/a.ts": 380 }, FILE_LINES)];

    const checked = await runGate({ mode: {}, ceilings: listed, signals });
    expect(checked.result.exitCode).toBe(1);
    expect(checked.result.output).toMatch(/entry can be deleted, run npm run budgets:update/);

    const updated = await runGate({
      mode: { update: true },
      ceilings: listed,
      signals,
    });
    expect(updated.result.exitCode).toBe(0);
    expect(updated.result.baseline.ceilings.get("fileLines")).toBeUndefined();
  });

  it("is a stale entry when nothing measures it any more", async () => {
    const listed = {
      fileLines: { "src/gone.ts": { value: 712, reason: SEEDED } },
    };

    const checked = await runGate({
      mode: {},
      ceilings: listed,
      signals: [ceiling({}, FILE_LINES)],
    });
    expect(checked.result.exitCode).toBe(1);
    expect(checked.result.output).toMatch(/stale entry: nothing is measured under this key/);

    const updated = await runGate({
      mode: { update: true },
      ceilings: listed,
      signals: [ceiling({}, FILE_LINES)],
    });
    expect(updated.result.exitCode).toBe(0);
    expect(updated.result.baseline.ceilings.get("fileLines")).toBeUndefined();
  });

  it("fails while it is listed without a reason", async () => {
    const { result } = await runGate({
      mode: {},
      ceilings: { fileLines: { "src/a.ts": { value: 712, reason: "" } } },
      signals: [ceiling({ "src/a.ts": 712 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/listed without a reason/);
  });
});

// ---------------------------------------------------------------------------
// Floor states
// ---------------------------------------------------------------------------

describe("a floor key", () => {
  it("fails below its floor", async () => {
    const { result } = await runGate({
      mode: {},
      floors: { soundnessCases: { cases: { value: 21, reason: SEEDED } } },
      signals: [floor({ cases: 20 })],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/20, below its floor 21 \(-1\) — restore it/);
  });

  it("fails above its floor in check mode and is raised by --update", async () => {
    const listed = { soundnessCases: { cases: { value: 21, reason: SEEDED } } };

    const checked = await runGate({
      mode: {},
      floors: listed,
      signals: [floor({ cases: 24 })],
    });
    expect(checked.result.exitCode).toBe(1);
    expect(checked.result.output).toMatch(/floor can be raised, run npm run budgets:update/);

    const updated = await runGate({
      mode: { update: true },
      floors: listed,
      signals: [floor({ cases: 24 })],
    });
    expect(updated.result.exitCode).toBe(0);
    expect(updated.result.baseline.floors.get("soundnessCases")?.get("cases")?.value).toBe(24);
  });

  it("passes silently at its floor", async () => {
    const { result } = await runGate({
      mode: {},
      floors: { soundnessCases: { cases: { value: 21, reason: SEEDED } } },
      signals: [floor({ cases: 21 })],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(/cases/);
  });

  it("passes while unlisted, and --today records it", async () => {
    const signals = [floor({ cases: 21 })];

    const checked = await runGate({ mode: {}, signals });
    expect(checked.result.exitCode).toBe(0);

    const recorded = await runGate({
      mode: { update: true, today: TODAY },
      signals,
    });
    expect(recorded.result.exitCode).toBe(0);
    expect(recorded.result.baseline.floors.get("soundnessCases")?.get("cases")).toStrictEqual({
      value: 21,
      reason: `recorded ${TODAY}`,
    });
  });

  it("fails when the floor records a key nothing measures", async () => {
    const { result } = await runGate({
      mode: {},
      floors: { soundnessCases: { cases: { value: 21, reason: SEEDED } } },
      signals: [floor({ other: 3 })],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/recorded by the floor but nothing measures it now/);
  });

  it("keeps the key its count moved to through a raise and a seed", async () => {
    const listed = {
      soundnessCases: {
        cases: { value: 21, reason: SEEDED, movedTo: "other" },
        other: { value: 5, reason: SEEDED },
      },
    };
    const signals = [floor({ cases: 24, other: 5 })];

    const raised = await runGate({
      mode: { update: true },
      floors: listed,
      signals,
    });
    expect(raised.result.baseline.floors.get("soundnessCases")?.get("cases")).toStrictEqual({
      value: 24,
      reason: SEEDED,
      movedTo: "other",
    });
    expect(raised.written.get(BASELINE_PATH)).toMatch(/"movedTo": "other"/);

    const seeded = await runGate({
      mode: { seed: true, today: TODAY },
      floors: listed,
      signals: [floor({ cases: 21, other: 5 })],
    });
    expect(seeded.result.baseline.floors.get("soundnessCases")?.get("cases")).toStrictEqual({
      value: 21,
      reason: SEEDED,
      movedTo: "other",
    });
  });

  it("fails when the key its count moved to is not one this section records", async () => {
    const { result } = await runGate({
      mode: {},
      floors: {
        soundnessCases: {
          cases: { value: 21, reason: SEEDED, movedTo: "gone" },
        },
      },
      signals: [floor({ cases: 21 })],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/movedTo names gone, which is not a key in this section/);
  });

  it("is skipped, not failed, when the floor has nothing to report", async () => {
    const { result } = await runGate({
      mode: {},
      floors: { soundnessCases: { cases: { value: 21, reason: SEEDED } } },
      signals: [floor({}, { id: "test-count", measure: "testCount" })],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/testCount: not measured \(no report\)/);
  });
});

// ---------------------------------------------------------------------------
// A signal that cannot answer
// ---------------------------------------------------------------------------

const broken: DoctorSignal = {
  ...ceiling({}, { id: "kind-inversions", measure: "kindMatrixViolations", threshold: 0 }),
  run: () => Promise.reject(new Error("kind undefined")),
};

describe("a signal that cannot answer", () => {
  it("warns with the reason, keeps its marks, and fails nothing", async () => {
    const { result, written } = await runGate({
      mode: { update: true },
      ceilings: {
        kindMatrixViolations: { "a -> b": { value: 3, reason: SEEDED } },
      },
      signals: [broken, ceiling({ "src/a.ts": 120 }, FILE_LINES)],
    });

    expect(result.output).toMatch(/warning: kindMatrixViolations: not measured: kind undefined/);
    expect(result.output).toMatch(/0 errors, 1 warnings/);
    expect(result.exitCode).toBe(0);
    expect([...(result.baseline.ceilings.get("kindMatrixViolations") ?? [])]).toStrictEqual([
      ["a -> b", { value: 3, reason: SEEDED }],
    ]);
    expect(written.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe("--file", () => {
  it("evaluates one path and ignores every other key", async () => {
    const { result } = await runGate({
      mode: { files: ["src/a.ts"] },
      tree: { "src/a.ts": "", "src/b.ts": "" },
      signals: [ceiling({ "src/a.ts": 120, "src/b.ts": 900 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(/src\/b\.ts/);
  });

  it("checks every selected path in one run", async () => {
    const { result } = await runGate({
      mode: { files: ["src/a.ts", "src/b.ts"] },
      tree: { "src/a.ts": "", "src/b.ts": "", "src/c.ts": "" },
      signals: [ceiling({ "src/a.ts": 500, "src/b.ts": 600, "src/c.ts": 900 }, FILE_LINES)],
    });

    expect(result.findings.map(({ key }) => key)).toStrictEqual(["src/a.ts", "src/b.ts"]);
  });

  it("catches a brand-new file git has not seen", async () => {
    const { result } = await runGate({
      mode: { files: ["src/new.ts"] },
      tree: { "src/new.ts": "" },
      signals: [ceiling({ "src/new.ts": 500 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/over the 400 ceiling and not listed/);
  });

  it("skips an exempt path", async () => {
    const { result } = await runGate({
      mode: { files: ["src/schema.generated.ts"] },
      tree: { "src/schema.generated.ts": "" },
      signals: [ceiling({ "src/schema.generated.ts": 5000 }, FILE_LINES)],
    });

    expect(result.exitCode).toBe(0);
  });

  it("leaves the floors alone, because one file is not a repository", async () => {
    const { result } = await runGate({
      mode: { files: ["src/a.ts"] },
      tree: { "src/a.ts": "" },
      floors: { soundnessCases: { cases: { value: 21, reason: SEEDED } } },
      signals: [floor({ cases: 2 })],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(/below its floor/);
  });
});

describe("--report and --json", () => {
  it("lists every listed and offending key with its mark", async () => {
    const { result } = await runGate({
      mode: { report: true },
      ceilings: { fileLines: { "src/a.ts": { value: 712, reason: SEEDED } } },
      signals: [ceiling({ "src/a.ts": 712, "src/b.ts": 900, "src/c.ts": 10 }, FILE_LINES)],
    });

    expect(result.output).toMatch(/fileLines src\/b\.ts: 900 lines \(mark none, ceiling 400\)/);
    expect(result.output).toMatch(/fileLines src\/a\.ts: 712 lines \(mark 712, ceiling 400\)/);
    expect(result.output).not.toMatch(/src\/c\.ts/);
  });

  it("names the key a floor's count moved to", async () => {
    const { result } = await runGate({
      mode: { report: true },
      floors: {
        soundnessCases: {
          cases: { value: 4, reason: SEEDED, movedTo: "other" },
          other: { value: 27, reason: SEEDED },
        },
      },
      signals: [floor({ cases: 4, other: 27 })],
    });

    expect(result.output).toMatch(/soundnessCases cases: 4 count \(mark 4, floor current, moved to other\)/);
  });

  it("reports the same outcome as a machine object", async () => {
    const { result } = await runGate({
      mode: { json: true },
      signals: [ceiling({ "src/a.ts": 900 }, FILE_LINES)],
    });
    const payload: unknown = JSON.parse(result.output);

    expect(payload).toMatchObject({
      ok: false,
      mode: "check",
      profile: "standard",
      summary: { errors: 1 },
      findings: [{ key: "src/a.ts" }],
    });
  });
});

// ---------------------------------------------------------------------------
// --seed
// ---------------------------------------------------------------------------

describe("--seed", () => {
  it("records every offender and every floor, and no compliant file", async () => {
    const { result, written } = await runGate({
      mode: { seed: true, today: TODAY },
      signals: [ceiling({ "src/a.ts": 712, "src/b.ts": 10 }, FILE_LINES), floor({ cases: 21 })],
    });

    expect(result.exitCode).toBe(0);
    expect(written.get(BASELINE_PATH)).toBeDefined();
    expect([...(result.baseline.ceilings.get("fileLines") ?? [])]).toStrictEqual([
      ["src/a.ts", { value: 712, reason: `seeded ${TODAY} before the gate existed` }],
    ]);
    expect(result.baseline.floors.get("soundnessCases")?.get("cases")?.value).toBe(21);
  });

  it("adds to a baseline that already records entries, and touches none of them", async () => {
    const { result } = await runGate({
      mode: { seed: true, today: TODAY, reason: "the split lands next week" },
      ceilings: { fileLines: { "src/a.ts": { value: 712, reason: SEEDED } } },
      signals: [ceiling({ "src/a.ts": 712, "src/b.ts": 900 }, FILE_LINES)],
    });
    const recorded = result.baseline.ceilings.get("fileLines");

    expect(result.exitCode).toBe(0);
    expect(recorded?.get("src/a.ts")).toStrictEqual({
      value: 712,
      reason: SEEDED,
    });
    expect(recorded?.get("src/b.ts")).toStrictEqual({
      value: 900,
      reason: `the split lands next week (recorded ${TODAY})`,
    });
    expect(result.output).toMatch(/seeded 1 ceiling entries and 0 floor entries/);
  });

  it("records only the key --key names", async () => {
    const { result } = await runGate({
      mode: { seed: true, today: TODAY, key: "src/b.ts", reason: "fastify" },
      signals: [ceiling({ "src/a.ts": 800, "src/b.ts": 900 }, FILE_LINES)],
    });

    expect([...(result.baseline.ceilings.get("fileLines") ?? [])]).toStrictEqual([
      ["src/b.ts", { value: 900, reason: `fastify (recorded ${TODAY})` }],
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/src\/a\.ts: 800 lines over the 400 ceiling/);
  });
});

// ---------------------------------------------------------------------------
// What the gate judges at all
// ---------------------------------------------------------------------------

describe("the signals a gate judges", () => {
  it("leaves a signal this profile only reports ungated and unseeded", async () => {
    const reportOnly = ceiling({ "packages/one": 23 }, { id: "blast-radius", measure: undefined, threshold: null });

    const { result } = await runGate({
      mode: { seed: true, today: TODAY },
      signals: [reportOnly],
    });

    expect(result.baseline.ceilings.get("blast-radius")).toBeUndefined();
    expect(result.output).not.toMatch(/blast-radius/);
    expect(gatedSignals([reportOnly], gateMode({}))).toStrictEqual([]);
  });

  it("judges a report-only standard signal once the strict profile names a number", () => {
    const strictOnly: DoctorSignal = {
      ...ceiling({ "src/a.ts": 3 }, { id: "god-classes", measure: undefined }),
      thresholds: { standard: null, strict: 0 },
    };

    expect(gatedSignals([strictOnly], gateMode({}))).toStrictEqual([]);
    expect(gatedSignals([strictOnly], gateMode({ profile: "strict" }))).toStrictEqual([strictOnly]);
  });

  it("names the section a signal is recorded under", () => {
    expect(baselineSectionOf(ceiling({}, FILE_LINES))).toBe("fileLines");
    expect(baselineSectionOf(ceiling({}, { id: "god-classes", measure: undefined }))).toBe("god-classes");
  });

  it("prints fix-or-baseline advice for non-size ceilings and split advice for size ceilings", async () => {
    const { result } = await runGate({
      mode: gateMode({}),
      signals: [
        ceiling({ "src/big.ts": 401 }, FILE_LINES),
        ceiling(
          { ".github/workflows/ci.yml": 1 },
          { id: "ci-without-verify", measure: undefined, unit: "count", threshold: 0 },
        ),
        ceiling(
          { "domains/notes": 1 },
          { id: "vendor-outside-adapter", measure: undefined, unit: "files", threshold: 0 },
        ),
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("401 lines over the 400 ceiling and not listed — split it");
    expect(result.output).toContain("1 count over the 0 ceiling and not listed — fix or baseline it");
    expect(result.output).toContain("1 files over the 0 ceiling and not listed — fix or baseline it");
  });
});
