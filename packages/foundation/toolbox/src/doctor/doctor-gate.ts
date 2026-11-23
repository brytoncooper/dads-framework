/**
 * `dad doctor --gate`: the same signals, held to a recorded baseline.
 *
 * The report describes a repository. The gate judges one, and it is the same
 * measurement either way — one signal, two views. A signal the active profile
 * gives a threshold is a **ceiling** the baseline may record exceptions to; a
 * signal whose direction is `floor` is judged against the number it was
 * recorded at, because a floor has no threshold to reach except the one the
 * repository already earned. A signal this profile only reports is not gated
 * and is not seeded: there is nothing to judge it against, and recording a
 * number nobody promised would be inventing a rule.
 *
 * The baseline section a signal is judged under is its `measure` name where it
 * names one and its id otherwise, so a baseline written by the source-budget
 * ratchet keeps working with no edit at all.
 *
 * A signal that cannot answer is a warning that names the reason, never a
 * confident zero and never a failure of the gate: a repository with no history
 * is not a repository that raised a mark. Its recorded entries are left exactly
 * as they are, so `--update` can never delete a baseline it could not measure.
 *
 * Nothing here reads the clock. Dates arrive through `--today`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDoctorContext, type DoctorContext, type DoctorContextInput } from "./doctor-context.js";
import { compareToBase, type ReadAtRef, type RefContents } from "./doctor-gate-base.js";
import { matchesExemptGlob, readGateBaseline, serializeBaseline } from "./doctor-gate-baseline.js";
import {
  BASELINE_PATH,
  countEntries,
  type BaselineEntries,
  type BaselineEntry,
  type GateBaseline,
  type GateFinding,
  type GateInventoryRow,
  type GateMeasure,
  type GateMode,
} from "./doctor-gate-model.js";
import { renderGateOutput, summarizeGate, type GateOutcome } from "./doctor-gate-render.js";
import { evaluateCeiling, evaluateFloor } from "./doctor-gate-states.js";
import { thresholdFor, type DoctorSignal } from "./doctor-signal.js";
import { DOCTOR_SIGNALS, runDoctorSignals, type SignalOutcome } from "./doctor-signals.js";
import { runGit } from "./signals/scanners/git-history.js";
import { isTypeScriptProjectFile } from "./signals/scanners/typescript-program.js";

/** Never measured, whatever a baseline does or does not say. */
const ALWAYS_EXEMPT = ["**/node_modules/**", "**/dist/**"];

export type GateInput = {
  readonly root: string;
  readonly mode: GateMode;
  /** The signals to judge. Defaults to every signal the doctor ships. */
  readonly signals?: readonly DoctorSignal[] | undefined;
  readonly exec?: DoctorContextInput["exec"];
  /** Writes the baseline. Defaults to the file under the root. */
  readonly write?: ((path: string, text: string) => void) | undefined;
  /** Reads a path at a git ref. Defaults to a read-only `git show`. */
  readonly readAtRef?: ReadAtRef | undefined;
};

export type GateResult = {
  readonly exitCode: number;
  readonly output: string;
  readonly findings: readonly GateFinding[];
  readonly baseline: GateBaseline;
  readonly wrote: boolean;
};

/** The section of the baseline a signal is recorded under. */
export function baselineSectionOf(signal: DoctorSignal): string {
  return signal.measure ?? signal.id;
}

/**
 * The signals a gate run judges: every floor, and every ceiling this profile
 * gives a number, except a signal marked report-only. File-scoped runs
 * leave repository floors, history, and network checks to the full gate.
 */
export function gatedSignals(signals: readonly DoctorSignal[], mode: GateMode): readonly DoctorSignal[] {
  return signals.filter((signal) => {
    if (signal.reportOnly === true) return false;
    if (
      mode.files !== undefined &&
      (signal.direction === "floor" || signal.reads === "git" || signal.reads === "online")
    ) {
      return false;
    }
    if (signal.direction === "floor") return true;
    return thresholdFor(signal, mode.profile) !== null;
  });
}

/** Runs one invocation of the gate. */
export async function runDoctorGate(input: GateInput): Promise<GateResult> {
  const mode = input.mode;
  const probe = createDoctorContext({
    root: input.root,
    today: mode.today,
    exec: input.exec,
  });
  const baseline = readGateBaseline(probe);
  const before = serializeBaseline(baseline);

  const measured =
    mode.base === undefined ? await measuredOutcome(input, probe, baseline) : comparedOutcome(input, probe, baseline);
  const outcome = mode.seed ? withSeedNote(measured, baseline) : measured;

  const wrote = writeBaseline(input, outcome, before);
  const summary = summarizeGate(outcome);
  return {
    exitCode: summary.errors > 0 ? 1 : 0,
    output: renderGateOutput(outcome, summary),
    findings: outcome.findings,
    baseline: outcome.baseline,
    wrote,
  };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

async function measuredOutcome(input: GateInput, probe: DoctorContext, baseline: GateBaseline): Promise<GateOutcome> {
  const mode = input.mode;
  const selection = selectFiles(probe, baseline, mode);
  const context = createDoctorContext({
    root: input.root,
    today: mode.today,
    exec: input.exec,
    files: selection.visible,
  });
  const signals = gatedSignals(input.signals ?? DOCTOR_SIGNALS, mode);
  const outcomes = await runDoctorSignals(context, signals);
  return judgeOutcomes(outcomes, baseline, mode, selection.judged);
}

/**
 * What a run may look at, and what it may judge.
 *
 * They are the same list except in `--file` mode, where only the named paths are judged, measured whether or not git has seen them,
 * which is the case the edit guard exists for: a brand-new 500-line file must
 * not pass because nobody has staged it. What the signals may *look at* is
 * those paths plus the workspace's `tsconfig.json` files, because a file list
 * with no project in it is a workspace with no TypeScript program, and the
 * guard would then measure a file without any of the questions the compiler
 * answers. The projects place the file; they never produce a judgement,
 * because only the named paths are judged.
 */
type FileSelection = {
  readonly visible: readonly string[];
  /** The keys a reading may carry, or `undefined` when nothing is narrowed. */
  readonly judged: ReadonlySet<string> | undefined;
};

function selectFiles(context: DoctorContext, baseline: GateBaseline, mode: GateMode): FileSelection {
  const exempt = [...baseline.exempt, ...ALWAYS_EXEMPT];
  const isExempt = (path: string): boolean => exempt.some((glob) => matchesExemptGlob(path, glob));
  if (mode.files === undefined) {
    const visible = context.files().filter((path) => !isExempt(path));
    return { visible, judged: undefined };
  }
  const judged = [...new Set(mode.files)].filter((path) => !isExempt(path) && context.exists(path));
  if (judged.length === 0) {
    return { visible: [], judged: new Set() };
  }
  const projects = context.files().filter(isTypeScriptProjectFile);
  return {
    visible: [...new Set([...projects, ...judged])],
    judged: new Set(judged),
  };
}

type Judgement = {
  readonly findings: GateFinding[];
  readonly notes: string[];
  readonly inventory: GateInventoryRow[];
  readonly ceilings: Map<string, BaselineEntries>;
  readonly floors: Map<string, BaselineEntries>;
};

function judgeOutcomes(
  outcomes: readonly SignalOutcome[],
  baseline: GateBaseline,
  mode: GateMode,
  judged: ReadonlySet<string> | undefined,
): GateOutcome {
  const judgement: Judgement = {
    findings: [],
    notes: [],
    inventory: [],
    ceilings: new Map(baseline.ceilings),
    floors: new Map(baseline.floors),
  };
  for (const outcome of outcomes) {
    judgeOne(judgement, outcome, mode, judged);
  }
  return {
    mode,
    baseline: {
      ...baseline,
      ceilings: judgement.ceilings,
      floors: judgement.floors,
    },
    findings: judgement.findings,
    notes: judgement.notes,
    inventory: judgement.inventory,
  };
}

function judgeOne(
  judgement: Judgement,
  outcome: SignalOutcome,
  mode: GateMode,
  judged: ReadonlySet<string> | undefined,
): void {
  const signal = outcome.signal;
  const section = baselineSectionOf(signal);
  judgement.notes.push(...notesOf(section, outcome));
  if (outcome.failure !== undefined) {
    judgement.findings.push(notMeasured(section, outcome.failure));
    return;
  }

  const ceiling = signal.direction === "ceiling";
  const values = narrowValues(outcome, judged);
  if (!ceiling && values.size === 0) {
    judgement.notes.push(`${section}: not measured (no report)`);
    return;
  }

  const measure: GateMeasure = {
    name: section,
    threshold: thresholdFor(signal, mode.profile) ?? 0,
    unit: signal.unit,
  };
  const sections = ceiling ? judgement.ceilings : judgement.floors;
  const entries = sections.get(section) ?? new Map<string, BaselineEntry>();
  recordInventory(judgement.inventory, signal, measure, entries, values);

  const evaluated = ceiling
    ? evaluateCeiling(measure, entries, values, mode)
    : evaluateFloor(measure, entries, values, mode);
  judgement.findings.push(...evaluated.findings);
  if (evaluated.entries.size > 0) sections.set(section, evaluated.entries);
  else sections.delete(section);
}

/** What a signal said about how it answered, under its section's name. */
function notesOf(section: string, outcome: SignalOutcome): readonly string[] {
  return (outcome.notes ?? []).map((note) => `${section}: ${note}`);
}

/**
 * A signal that could not answer says so and fails nothing. The absence of a
 * git history, of a TypeScript project, or of a date is not a loosening, and a
 * gate that failed on it would be a gate nobody could run on their own
 * repository.
 */
function notMeasured(section: string, reason: string): GateFinding {
  return {
    level: "warning",
    measure: section,
    key: "",
    value: undefined,
    mark: undefined,
    message: `not measured: ${reason}`,
  };
}

/**
 * The numbers, keyed the way the baseline keys them. A narrowed run keeps only
 * the keys it was narrowed to, which covers the signals that answer from
 * somewhere other than the file list. A file-scoped run judges only the
 * selected paths, whatever else a signal counted on the way.
 */
function narrowValues(outcome: SignalOutcome, judged: ReadonlySet<string> | undefined): ReadonlyMap<string, number> {
  const values = new Map<string, number>();
  for (const [key, reading] of outcome.readings) {
    if (judged !== undefined && !judged.has(key)) continue;
    values.set(key, reading.value);
  }
  return values;
}

function recordInventory(
  inventory: GateInventoryRow[],
  signal: DoctorSignal,
  measure: GateMeasure,
  entries: BaselineEntries,
  values: ReadonlyMap<string, number>,
): void {
  const ceiling = signal.direction === "ceiling";
  for (const [key, value] of values) {
    const entry = entries.get(key);
    const movedTo = entry?.movedTo;
    inventory.push({
      measure: measure.name,
      direction: signal.direction,
      threshold: ceiling ? measure.threshold : null,
      unit: measure.unit,
      key,
      value,
      mark: entry?.value,
      ...(movedTo === undefined ? {} : { movedTo }),
    });
  }
}

// ---------------------------------------------------------------------------
// Comparing against a ref
// ---------------------------------------------------------------------------

/** The baseline names of the floors the gate only reports. */
function reportOnlyFloorMeasures(signals: readonly DoctorSignal[]): ReadonlySet<string> {
  return new Set(signals.filter((signal) => signal.reportOnly === true).map((signal) => signal.measure ?? signal.id));
}

function comparedOutcome(input: GateInput, context: DoctorContext, baseline: GateBaseline): GateOutcome {
  const compared = compareToBase({
    baseline,
    context,
    base: input.mode.base ?? "",
    readAtRef: input.readAtRef ?? gitShowAtRef(input.root),
    reportOnlyFloors: reportOnlyFloorMeasures(input.signals ?? DOCTOR_SIGNALS),
  });
  return {
    mode: input.mode,
    baseline,
    findings: compared.findings,
    notes: compared.notes,
    inventory: [],
  };
}

/** One read-only `git show`, through the one function the doctor spawns git in. */
function gitShowAtRef(root: string): ReadAtRef {
  return (ref: string, path: string): RefContents => runGit(root, "show", [`${ref}:${path}`]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * `--update` writes what it fixed even when something else still fails: a new
 * offender elsewhere must not block the marks that legitimately came down.
 * `--seed` writes even when it recorded nothing, so a repository that adopts
 * the gate gets its baseline file.
 */
function writeBaseline(input: GateInput, outcome: GateOutcome, before: string): boolean {
  const mode = input.mode;
  if (!mode.update && !mode.seed) return false;
  const serialized = serializeBaseline(outcome.baseline);
  if (!mode.seed && serialized === before) return false;
  const write = input.write ?? defaultWrite(input.root);
  write(BASELINE_PATH, serialized);
  return true;
}

function defaultWrite(root: string): (path: string, text: string) => void {
  return (path, text) => {
    writeFileSync(join(root, path), text);
  };
}

/**
 * What a seed run recorded, said out loud, because it wrote a tracked file.
 * A seed only ever adds, so the numbers are the entries this run is
 * responsible for and not the size of the baseline it joined.
 */
function withSeedNote(outcome: GateOutcome, before: GateBaseline): GateOutcome {
  const ceilings = countEntries(outcome.baseline.ceilings) - countEntries(before.ceilings);
  const floors = countEntries(outcome.baseline.floors) - countEntries(before.floors);
  return {
    ...outcome,
    notes: [...outcome.notes, `seeded ${ceilings} ceiling entries and ${floors} floor entries into ${BASELINE_PATH}`],
  };
}
