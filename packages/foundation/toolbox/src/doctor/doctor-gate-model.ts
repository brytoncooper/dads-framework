/**
 * The vocabulary the gate speaks: the mode it was asked for, the baseline it
 * judges against, and the finding it answers with.
 *
 * `dad doctor` reports. `dad doctor --gate` holds the same signals to a
 * recorded baseline — a number that may not grow (a **ceiling**) or may not
 * shrink (a **floor**), a threshold every key is expected to reach, and a list
 * of exceptions that may only ever move toward that threshold. This module is
 * the small shared middle of that: no file is read here, no signal is run, and
 * nothing reads the clock. Dates arrive as `today`.
 *
 * A recorded entry is one number, one reason, and — on a floor whose count
 * moved to another key — the key it moved to. The file writes the number as
 * `mark` under `ceilings` and as `floor` under `floors`; everything above the
 * file calls it `value`, so a ceiling state and a floor state can be written
 * once instead of twice.
 */

import type { DoctorProfile, SignalUnit } from "./doctor-signal.js";

export const BASELINE_PATH = ".agents/source-budgets.json";
export const SUPPRESSIONS_PATH = "eslint-suppressions.json";
export const UPDATE_COMMAND = "npm run budgets:update";

/** One recorded exception: the number it was recorded at, and why. */
export type BaselineEntry = {
  readonly value: number;
  /** Absent when the file records none, which is an error in every mode. */
  readonly reason: string | undefined;
  /**
   * The key in the same section a floor's count moved to. A floor may fall
   * only where its entry says where the count went and that key rose by at
   * least the fall; the receipt stays on the entry afterwards, and a later
   * diff that does not fall on this key ignores it.
   */
  readonly movedTo?: string | undefined;
};

/** One section's exceptions, keyed the way the signal keys its readings. */
export type BaselineEntries = ReadonlyMap<string, BaselineEntry>;

/** Every section of `ceilings` or of `floors`, keyed by section name. */
export type BaselineSections = ReadonlyMap<string, BaselineEntries>;

export type GateBaseline = {
  readonly countedLines: string;
  readonly exempt: readonly string[];
  readonly ceilings: BaselineSections;
  readonly floors: BaselineSections;
};

/**
 * What one invocation was asked to do. Every field is what the caller wrote:
 * the gate adds nothing and assumes nothing, so two runs with the same mode
 * over the same tree print the same bytes.
 */
export type GateMode = {
  readonly json: boolean;
  readonly update: boolean;
  readonly seed: boolean;
  readonly report: boolean;
  readonly profile: DoctorProfile;
  /** Repository-relative paths, measured whether or not git has seen them. */
  readonly files: readonly string[] | undefined;
  /** A git ref whose baseline this one is compared against. */
  readonly base: string | undefined;
  readonly today: string | undefined;
  /** The reason a seeded entry carries, beside the date it was recorded. */
  readonly reason: string | undefined;
  /** The one key `--seed` may record, when the caller named one. */
  readonly key: string | undefined;
};

/** A `fixed` finding is a move `--update` or `--seed` already made. */
export type FindingLevel = "error" | "warning" | "fixed";

export type GateFinding = {
  readonly level: FindingLevel;
  /** The baseline section, which is the signal's measure name or its id. */
  readonly measure: string;
  readonly key: string;
  readonly value: number | undefined;
  readonly mark: number | undefined;
  readonly message: string;
};

/** One signal, as the states judge it: a section, a number, and a unit. */
export type GateMeasure = {
  readonly name: string;
  /** The active profile's ceiling. A floor is judged by its recorded number. */
  readonly threshold: number;
  readonly unit: SignalUnit;
};

/** One row of `--report`: what a key measures and what it is listed at. */
export type GateInventoryRow = {
  readonly measure: string;
  readonly direction: "ceiling" | "floor";
  readonly threshold: number | null;
  readonly unit: SignalUnit;
  readonly key: string;
  readonly value: number;
  readonly mark: number | undefined;
  /** The key a floor's count moved to, where its entry records one. */
  readonly movedTo?: string | undefined;
};

/** What one section's evaluation decided: what to say, and what to record. */
export type GateEvaluation = {
  readonly findings: readonly GateFinding[];
  readonly entries: BaselineEntries;
};

// ---------------------------------------------------------------------------
// Small shared facts
// ---------------------------------------------------------------------------

/** Codepoint ordering, so a written baseline is identical on every machine. */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Every exception has to say what stops the key from reaching the threshold. */
export function hasReason(entry: BaselineEntry | undefined): boolean {
  return entry !== undefined && (entry.reason ?? "").trim().length > 0;
}

/**
 * The same entry recorded at another number, keeping its reason and its
 * `movedTo`. A move a tool makes toward the threshold rewrites the number and
 * nothing else, so the receipt an entry carries survives every `--update`.
 */
export function entryAt(
  entry: BaselineEntry | undefined,
  value: number,
): BaselineEntry {
  const movedTo = entry?.movedTo;
  if (movedTo === undefined) return { value, reason: entry?.reason };
  return { value, reason: entry?.reason, movedTo };
}

/**
 * What is wrong with an entry's `movedTo`, or `undefined` when it names a key
 * this section records. A receipt that names its own key or a key nobody
 * records is an error in every mode: it points at arithmetic nobody can check.
 */
export function movedToProblem(
  key: string,
  entry: BaselineEntry,
  entries: BaselineEntries,
): string | undefined {
  const movedTo = entry.movedTo;
  if (movedTo === undefined) return undefined;
  if (movedTo === key) return "movedTo names its own key";
  if (!entries.has(movedTo)) {
    return `movedTo names ${movedTo}, which is not a key in this section`;
  }
  return undefined;
}

/** Total entries across every section of `ceilings` or of `floors`. */
export function countEntries(sections: BaselineSections): number {
  let total = 0;
  for (const entries of sections.values()) total += entries.size;
  return total;
}

/** Keys in codepoint order, so a run prints its findings the same way twice. */
export function sortedKeys(keys: Iterable<string>): readonly string[] {
  return [...keys].sort(compareStrings);
}

/**
 * The reason a seeded entry carries. An exception needs a reason and a date,
 * so the date `--today` supplied is written into the reason whichever way the
 * caller phrased it: `--seed` alone records that the key predates the gate,
 * and `--seed --reason` records the caller's sentence with the date beside it.
 */
export function recordedReason(mode: GateMode): string {
  const today = mode.today ?? "";
  if (mode.reason === undefined) {
    return `seeded ${today} before the gate existed`;
  }
  return `${mode.reason} (recorded ${today})`;
}

/** One finding, in the shape every renderer reads. */
export function gateFinding(
  level: FindingLevel,
  measure: GateMeasure,
  key: string,
  value: number | undefined,
  mark: number | undefined,
  message: string,
): GateFinding {
  return { level, measure: measure.name, key, value, mark, message };
}
