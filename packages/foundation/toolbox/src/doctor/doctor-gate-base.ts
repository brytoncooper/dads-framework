/**
 * The pawl: the working-tree baseline against the one at a git ref.
 *
 * Every local write moves toward the threshold, but a baseline is a text file
 * and a text file can be edited by hand. `--base <ref>` is what makes that
 * pointless. It fails on every direction of loosening — a mark that rose, a
 * floor that fell or disappeared, an entry that lost its reason, and an
 * `eslint-suppressions.json` that gained a file, a rule, or a count — and it
 * never fails on an addition. An entry that does not exist at the ref is a new
 * exception: it is named under its own heading, because a reviewer is the right
 * gate for a new exception and a tool is not.
 *
 * A floor may fall in exactly one case: the same diff says where its count
 * went, and the arithmetic holds. The entry names another key in the same
 * section through `movedTo`, that key rose in this comparison by at least the
 * fall, and the entry still says why — a package split, with the receipt in
 * the diff that made it. That move is named under its own heading as well,
 * because it is a fact a reviewer reads and not a failure. Every other fall is
 * the loosening it always was.
 *
 * Package-owned floors may retire when the base proves the former package
 * identity and both the identity and its path disappeared. A same-name
 * relocation needs a separate receipt and compiled negative proof at its
 * replacement roots. Global and surviving floors are still held.
 */

import { suppressionEntriesIn } from "./signals/scanners/text-suppressions-file.js";
import { parseGateBaseline } from "./doctor-gate-baseline.js";
import {
  BASELINE_PATH,
  hasReason,
  movedToProblem,
  sortedKeys,
  SUPPRESSIONS_PATH,
  type BaselineEntries,
  type BaselineEntry,
  type BaselineSections,
  type GateBaseline,
  type GateFinding,
} from "./doctor-gate-model.js";

import { retiredOwnerFloors } from "./doctor-gate-retirements.js";
import type { DoctorContext } from "./doctor-context.js";

/** What a file looked like at a ref, or the fact that it was not there. */
export type RefContents = {
  readonly status: number;
  readonly stdout: string;
};

/** Reads one repository-relative path at one ref. */
export type ReadAtRef = (ref: string, path: string) => RefContents;

export type BaseComparison = {
  readonly findings: readonly GateFinding[];
  readonly notes: readonly string[];
};

export type BaseComparisonInput = {
  readonly baseline: GateBaseline;
  readonly base: string;
  readonly readAtRef: ReadAtRef;
  /**
   * Floor measures the gate only reports. Their entries may fall or go away
   * without that being a loosening, because nothing holds them any more.
   */
  readonly reportOnlyFloors?: ReadonlySet<string>;
  readonly context?: DoctorContext;
};

/** Compares this baseline against the one at `<ref>`. */
export function compareToBase(input: BaseComparisonInput): BaseComparison {
  const shown = input.readAtRef(input.base, BASELINE_PATH);
  const missing = shown.status !== 0;
  const base = missing ? { ceilings: emptySections(), floors: emptySections() } : parseGateBaseline(shown.stdout);

  const ceilings = compareSection({
    current: input.baseline.ceilings,
    base: base.ceilings,
    field: "mark",
    verb: "rose",
    loosened: (now, before) => now > before,
    requireKept: false,
    transfers: false,
  });
  const held = (sections: BaselineSections): BaselineSections =>
    withoutMeasures(sections, input.reportOnlyFloors ?? new Set());
  const floors = compareSection({
    current: held(input.baseline.floors),
    base: held(base.floors),
    field: "floor",
    verb: "fell",
    loosened: (now, before) => now < before,
    requireKept: true,
    transfers: true,
  });

  const retired = retiredOwnerFloors(input, base.floors);
  const notes = [...retired.notes];
  if (missing) notes.push(`${BASELINE_PATH} does not exist at ${input.base}`);
  const additions = [...ceilings.additions, ...floors.additions];
  if (additions.length > 0) {
    notes.push(`new exceptions since ${input.base}:`, ...additions.map((line) => `  ${line}`));
  }
  if (floors.transfers.length > 0) {
    notes.push(`floors moved since ${input.base}:`, ...floors.transfers.map((line) => `  ${line}`));
  }
  return {
    findings: [
      ...ceilings.findings,
      ...floors.findings.filter((finding) => !retired.keys.get(finding.measure)?.has(finding.key)),
      ...compareSuppressions(input.readAtRef, input.base),
    ],
    notes,
  };
}

function emptySections(): BaselineSections {
  return new Map();
}

function withoutMeasures(sections: BaselineSections, measures: ReadonlySet<string>): BaselineSections {
  return new Map([...sections].filter(([measure]) => !measures.has(measure)));
}

type SectionComparison = {
  readonly current: BaselineSections;
  readonly base: BaselineSections;
  readonly field: string;
  readonly verb: string;
  loosened(now: number, before: number): boolean;
  readonly requireKept: boolean;
  /** True where a number may move to another key rather than only rise. */
  readonly transfers: boolean;
};

type SectionOutcome = {
  readonly findings: readonly GateFinding[];
  readonly additions: readonly string[];
  /** The declared moves this comparison allowed, said out loud. */
  readonly transfers: readonly string[];
};

/** What comparing one section collected, before it is read back. */
type SectionTally = {
  readonly findings: GateFinding[];
  readonly additions: string[];
  readonly transfers: string[];
};

/** One key of one section, with the entries it is judged among. */
type KeyComparison = {
  readonly comparison: SectionComparison;
  readonly section: string;
  readonly entries: BaselineEntries;
  readonly key: string;
};

function compareSection(comparison: SectionComparison): SectionOutcome {
  const tally: SectionTally = { findings: [], additions: [], transfers: [] };

  for (const [section, entries] of comparison.current) {
    for (const key of sortedKeys(entries.keys())) {
      compareOneKey({ comparison, section, entries, key }, tally);
    }
  }

  if (!comparison.requireKept) return tally;
  return {
    ...tally,
    findings: [...tally.findings, ...removedEntries(comparison)],
  };
}

function compareOneKey(compared: KeyComparison, tally: SectionTally): void {
  const { comparison, section, entries, key } = compared;
  const entry = entries.get(key);
  if (entry === undefined) return;
  if (!hasReason(entry)) {
    tally.findings.push(baseError(section, key, "has no reason"));
  }
  const receipt = movedToProblem(key, entry, entries);
  if (receipt !== undefined) {
    tally.findings.push(baseError(section, key, receipt));
  }
  const previous = comparison.base.get(section)?.get(key);
  if (previous === undefined) {
    const why = hasReason(entry) ? ` (${entry.reason ?? ""})` : "";
    tally.additions.push(`${section} ${key}: ${comparison.field} ${entry.value}${why}`);
    return;
  }
  if (!comparison.loosened(entry.value, previous.value)) return;
  const verdict = judgeFall(compared, entry, previous.value);
  if (verdict.allowed) tally.transfers.push(`${section} ${key}: ${verdict.message}`);
  else tally.findings.push(baseError(section, key, verdict.message));
}

/** A number that moved the wrong way, and whether the file accounts for it. */
type FallVerdict = {
  readonly allowed: boolean;
  readonly message: string;
};

/**
 * The one loosening that is not one: a floor that fell because its count moved
 * to another key. The fall is allowed only when the entry says where the count
 * went, still says why, and the key it names rose in this same comparison by at
 * least the fall — a key absent at the base counting as zero. Everything else
 * is the loosening a fall has always been, including a receipt the destination
 * did not earn, and a ceiling never transfers at all.
 */
function judgeFall(compared: KeyComparison, entry: BaselineEntry, before: number): FallVerdict {
  const { comparison, section, entries, key } = compared;
  const fell = `${comparison.field} ${comparison.verb} ${before} -> ${entry.value}`;
  if (!comparison.transfers) return { allowed: false, message: fell };
  const movedTo = entry.movedTo;
  if (movedTo === undefined) {
    return { allowed: false, message: `${fell} with no movedTo` };
  }
  if (movedTo === key) {
    return {
      allowed: false,
      message: `${fell} with movedTo naming its own key`,
    };
  }
  if (!hasReason(entry)) {
    return { allowed: false, message: `${fell} with no reason on the entry` };
  }
  const destination = entries.get(movedTo);
  if (destination === undefined) {
    return {
      allowed: false,
      message: `${fell} with movedTo ${movedTo}, which the baseline does not record`,
    };
  }
  const fall = before - entry.value;
  const rise = destination.value - (comparison.base.get(section)?.get(movedTo)?.value ?? 0);
  if (rise < fall) {
    return {
      allowed: false,
      message: `${fell} with movedTo ${movedTo}, which rose ${rise}, not ${fall}`,
    };
  }
  return {
    allowed: true,
    message: `${comparison.field} moved ${fall} to ${movedTo} (which rose ${rise})`,
  };
}

function removedEntries(comparison: SectionComparison): readonly GateFinding[] {
  const findings: GateFinding[] = [];
  for (const [section, entries] of comparison.base) {
    for (const key of sortedKeys(entries.keys())) {
      if (comparison.current.get(section)?.get(key) !== undefined) continue;
      findings.push(baseError(section, key, `${comparison.field} entry removed (was ${entries.get(key)?.value ?? 0})`));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The suppressions file
// ---------------------------------------------------------------------------

type SuppressionCounts = {
  readonly files: number;
  readonly rules: number;
  readonly suppressions: number;
};

/**
 * The ESLint suppressions file is a second baseline with the same rule: it may
 * shrink and it may not grow. Neither side existing means there is nothing to
 * compare, not that it grew.
 */
function compareSuppressions(readAtRef: ReadAtRef, base: string): readonly GateFinding[] {
  const head = readAtRef("HEAD", SUPPRESSIONS_PATH);
  const previous = readAtRef(base, SUPPRESSIONS_PATH);
  if (head.status !== 0 || previous.status !== 0) return [];

  const now = suppressionCounts(head.stdout);
  const before = suppressionCounts(previous.stdout);
  const fields: readonly (keyof SuppressionCounts)[] = ["files", "rules", "suppressions"];
  return fields
    .filter((field) => now[field] > before[field])
    .map((field) => suppressionGrew(field, before[field], now[field]));
}

/**
 * The message names the file, so the finding's subject stays empty and the
 * rendered line does not say the file's name twice.
 */
function suppressionGrew(field: string, before: number, now: number): GateFinding {
  return {
    level: "error",
    measure: "",
    key: "",
    value: now,
    mark: before,
    message: `${SUPPRESSIONS_PATH}: ${field} grew ${before} -> ${now}`,
  };
}

/**
 * The three numbers the file may not grow in, read through the same flattening
 * the signals over the working tree use, so the gate and the report cannot
 * disagree about what the file says.
 */
function suppressionCounts(text: string): SuppressionCounts {
  const entries = suppressionEntriesIn(text);
  const files = new Set(entries.map((entry) => entry.path));
  const rules = new Set(entries.map((entry) => entry.rule));
  return {
    files: files.size,
    rules: rules.size,
    suppressions: entries.reduce((total, entry) => total + entry.count, 0),
  };
}

function baseError(section: string, key: string, message: string): GateFinding {
  return {
    level: "error",
    measure: section,
    key,
    value: undefined,
    mark: undefined,
    message,
  };
}
