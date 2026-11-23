/**
 * The two state machines: what a ceiling key and a floor key mean, and what
 * `--update` and `--seed` are allowed to do about them.
 *
 * The direction of every local write is toward the threshold and only toward
 * it. `--update` lowers a mark, deletes a ceiling entry whose key came back
 * under the threshold, and raises a floor; it never adds a ceiling entry and
 * never raises a mark, because a new offender is a split, not a recording.
 * `--seed` is the one mode that records, and it only ever adds: a key it
 * already knows is left exactly as it is, so seeding twice cannot loosen
 * anything, and every entry it writes carries a reason and the date.
 *
 * Nothing here reads a file or a clock.
 */

import {
  entryAt,
  gateFinding,
  hasReason,
  movedToProblem,
  recordedReason,
  sortedKeys,
  UPDATE_COMMAND,
  type BaselineEntries,
  type BaselineEntry,
  type GateEvaluation,
  type GateFinding,
  type GateMeasure,
  type GateMode,
} from "./doctor-gate-model.js";

/** What one key's state asks the run to do about the recorded entry. */
type StateAction = "delete" | "lower" | "raise" | "record";

type KeyState = {
  readonly action?: StateAction;
  readonly level: "error" | "warning" | "fixed";
  readonly message: string;
};

/** The readings one signal produced, as the states read them. */
export type MeasuredValues = ReadonlyMap<string, number>;

/** True when `--seed` may record this key: it records what it was pointed at. */
function seeding(mode: GateMode, key: string): boolean {
  if (!mode.seed) return false;
  return mode.key === undefined || mode.key === key;
}

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * Ceiling states, in the order they are decided:
 *
 * | key state                       | check                   | update  |
 * | ------------------------------- | ----------------------- | ------- |
 * | unlisted, at or under threshold | pass                    | pass    |
 * | unlisted, over threshold        | error                   | error   |
 * | listed, at or under threshold   | error, "can be deleted" | deleted |
 * | listed, above its mark          | error                   | error   |
 * | listed, at its mark             | warning                 | warning |
 * | listed, below its mark          | error, "can be lowered" | lowered |
 * | listed, nothing measured        | error, "stale entry"    | deleted |
 */
function ceilingState(
  measure: GateMeasure,
  entry: BaselineEntry | undefined,
  value: number,
  mode: GateMode,
  record: boolean,
): KeyState | undefined {
  const amount = `${value} ${measure.unit}`;
  if (entry === undefined) return unlistedCeiling(measure, value, record);

  if (value <= measure.threshold) {
    const fate = mode.update ? "deleted" : `can be deleted, run ${UPDATE_COMMAND}`;
    return {
      action: "delete",
      level: mode.update ? "fixed" : "error",
      message: `${amount} at or under the ${measure.threshold} ceiling — entry ${fate}`,
    };
  }

  if (value > entry.value) {
    return {
      level: "error",
      message: `${amount}, above its mark ${entry.value} (+${value - entry.value}) — the ratchet only turns down`,
    };
  }

  if (value === entry.value) {
    return {
      level: "warning",
      message: `${amount} at its mark (ceiling ${measure.threshold}, delta 0)`,
    };
  }

  return {
    action: "lower",
    level: mode.update ? "fixed" : "error",
    message: mode.update
      ? `mark lowered ${entry.value} -> ${value} (${value - entry.value})`
      : `${amount}, below its mark ${entry.value} (${value - entry.value}) — mark can be lowered, run ${UPDATE_COMMAND}`,
  };
}

const SIZE_MEASURES = new Set(["fileLines", "testFileLines", "functions-over-ceiling"]);

/**
 * A key nobody recorded. Under the threshold it is simply fine; over it, it is
 * either the exception a seed was asked to record or the fix/split nobody has made.
 */
function unlistedCeiling(measure: GateMeasure, value: number, record: boolean): KeyState | undefined {
  if (value <= measure.threshold) return undefined;
  if (record) {
    return {
      action: "record",
      level: "fixed",
      message: `recorded at ${value}`,
    };
  }
  const action = measure.unit === "lines" || SIZE_MEASURES.has(measure.name) ? "split it" : "fix or baseline it";
  return {
    level: "error",
    message: `${value} ${measure.unit} over the ${measure.threshold} ceiling and not listed — ${action}`,
  };
}

/** Applies the ceiling states to one signal's keys. */
export function evaluateCeiling(
  measure: GateMeasure,
  entries: BaselineEntries,
  values: MeasuredValues,
  mode: GateMode,
): GateEvaluation {
  const findings: GateFinding[] = [];
  const next = new Map(entries);

  for (const key of sortedKeys(values.keys())) {
    const value = values.get(key) ?? 0;
    const entry = entries.get(key);
    if (entry !== undefined && !hasReason(entry)) {
      const problem = "listed without a reason";
      findings.push(gateFinding("error", measure, key, value, entry.value, problem));
    }

    const record = seeding(mode, key);
    const state = ceilingState(measure, entry, value, mode, record);
    if (state === undefined) continue;
    applyCeilingAction({ state, next, key, value, entry, mode });
    findings.push(gateFinding(state.level, measure, key, value, entry?.value, state.message));
  }

  // A file-scoped run cannot conclude that unmeasured paths are stale.
  if (mode.files !== undefined) return { findings, entries: next };
  findings.push(...staleCeilings(measure, entries, values, mode, next));
  return { findings, entries: next };
}

type CeilingApplication = {
  readonly state: KeyState;
  readonly next: Map<string, BaselineEntry>;
  readonly key: string;
  readonly value: number;
  readonly entry: BaselineEntry | undefined;
  readonly mode: GateMode;
};

function applyCeilingAction(applied: CeilingApplication): void {
  const { state, next, key, value, entry, mode } = applied;
  if (state.action === "delete" && mode.update) next.delete(key);
  if (state.action === "lower" && mode.update) {
    next.set(key, entryAt(entry, value));
  }
  if (state.action === "record") {
    next.set(key, { value, reason: recordedReason(mode) });
  }
}

function staleCeilings(
  measure: GateMeasure,
  entries: BaselineEntries,
  values: MeasuredValues,
  mode: GateMode,
  next: Map<string, BaselineEntry>,
): readonly GateFinding[] {
  const findings: GateFinding[] = [];
  for (const key of sortedKeys(entries.keys())) {
    if (values.has(key)) continue;
    if (mode.update) next.delete(key);
    findings.push(
      gateFinding(
        mode.update ? "fixed" : "error",
        measure,
        key,
        undefined,
        entries.get(key)?.value,
        `stale entry: nothing is measured under this key${mode.update ? " — entry deleted" : ""}`,
      ),
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

/**
 * Floor states. A floor is a count that has to keep going up — tests, negative
 * type tests, error-level lint rules, documented packages — so its failures are
 * a ceiling's mirror image: falling below the floor, and a recorded key that
 * nothing measures any more. A floor entry is never deleted by a tool; deleting
 * one is a loosening, which is why `compareToBase` also fails on a removal.
 *
 * An entry may say its count moved to another key in the same section. No mode
 * here writes that receipt — only whoever made the split can say where the
 * count went — but `--update` carries it through every raise, and a receipt
 * naming its own key or a key this section does not record is an error in
 * every mode, because the pawl could not check the arithmetic behind it.
 *
 * A floor is judged against the number it is recorded at, never against a
 * profile's threshold: the profile says what a ceiling may reach, and a floor
 * has no number to reach except the one this repository already earned.
 */
function floorState(
  entry: BaselineEntry | undefined,
  value: number,
  mode: GateMode,
  record: boolean,
): KeyState | undefined {
  if (entry === undefined) return newFloorState(value, mode, record);

  if (value < entry.value) {
    return {
      level: "error",
      message: `${value}, below its floor ${entry.value} (${value - entry.value}) — restore it`,
    };
  }
  if (value === entry.value) return undefined;

  return {
    action: "raise",
    level: mode.update ? "fixed" : "error",
    message: mode.update
      ? `floor raised ${entry.value} -> ${value} (+${value - entry.value})`
      : `${value}, above its floor ${entry.value} (+${value - entry.value}) — floor can be raised, run ${UPDATE_COMMAND}`,
  };
}

function newFloorState(value: number, mode: GateMode, record: boolean): KeyState | undefined {
  if (record) {
    return {
      action: "record",
      level: "fixed",
      message: `recorded with floor ${value}`,
    };
  }
  if (!mode.update) return undefined;
  if (mode.today === undefined) {
    return {
      level: "warning",
      message: `new key measured at ${value} but not recorded — pass --today YYYY-MM-DD to record it`,
    };
  }
  return {
    action: "record",
    level: "fixed",
    message: `new key recorded with floor ${value}`,
  };
}

/** Applies the floor states to one signal's keys. */
export function evaluateFloor(
  measure: GateMeasure,
  entries: BaselineEntries,
  values: MeasuredValues,
  mode: GateMode,
): GateEvaluation {
  const findings: GateFinding[] = [];
  const next = new Map(entries);

  for (const key of sortedKeys(values.keys())) {
    findings.push(...judgeFloorKey({ measure, entries, values, mode, next, key }));
  }

  findings.push(...unmeasuredFloors(measure, entries, values));
  return { findings, entries: next };
}

type FloorJudgement = {
  readonly measure: GateMeasure;
  readonly entries: BaselineEntries;
  readonly values: MeasuredValues;
  readonly mode: GateMode;
  readonly next: Map<string, BaselineEntry>;
  readonly key: string;
};

/**
 * What the file itself gets wrong about an entry, before anything is measured:
 * an exception that never said why, and a receipt whose arithmetic nobody can
 * check because it names its own key or a key this section does not record.
 */
function floorEntryProblems(judged: FloorJudgement, value: number): readonly GateFinding[] {
  const { measure, entries, key } = judged;
  const entry = entries.get(key);
  if (entry === undefined) return [];
  const problems = hasReason(entry) ? [] : ["listed without a reason"];
  const receipt = movedToProblem(key, entry, entries);
  if (receipt !== undefined) problems.push(receipt);
  return problems.map((problem) => gateFinding("error", measure, key, value, entry.value, problem));
}

function judgeFloorKey(judged: FloorJudgement): readonly GateFinding[] {
  const { measure, entries, values, mode, next, key } = judged;
  const value = values.get(key) ?? 0;
  const entry = entries.get(key);
  const findings: GateFinding[] = [...floorEntryProblems(judged, value)];

  const record = seeding(mode, key);
  const state = floorState(entry, value, mode, record);
  if (state === undefined) return findings;
  if (state.action === "record") {
    next.set(key, { value, reason: floorReason(mode, record) });
  }
  if (state.action === "raise" && mode.update) {
    next.set(key, entryAt(entry, value));
  }
  findings.push(gateFinding(state.level, measure, key, value, entry?.value, state.message));
  return findings;
}

function floorReason(mode: GateMode, record: boolean): string {
  return record ? recordedReason(mode) : `recorded ${mode.today ?? ""}`;
}

function unmeasuredFloors(
  measure: GateMeasure,
  entries: BaselineEntries,
  values: MeasuredValues,
): readonly GateFinding[] {
  const findings: GateFinding[] = [];
  for (const key of sortedKeys(entries.keys())) {
    if (values.has(key)) continue;
    findings.push(
      gateFinding(
        "error",
        measure,
        key,
        undefined,
        entries.get(key)?.value,
        "recorded by the floor but nothing measures it now",
      ),
    );
  }
  return findings;
}
