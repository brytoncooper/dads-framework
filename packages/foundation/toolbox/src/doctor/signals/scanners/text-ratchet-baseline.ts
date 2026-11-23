/**
 * The ratchet baseline, read as a list of entries and a list of exemptions.
 *
 * Two gaslighting readings ask something of the same file: whether every
 * recorded exception says what it is, and whether an exemption glob reaches
 * code somebody wrote. Both questions are about the record rather than about
 * the code, so both are answered from this one flattening of it.
 *
 * A ceiling entry records a `mark` and a `reason`; a floor entry records a
 * `floor` and a `reason`. This module keeps only what both have in common,
 * because neither reading is about the number.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";

/** Where a repository that has adopted Dads records its ratchet. */
export const BASELINE_FILE = ".agents/source-budgets.json";

const SECTIONS = ["ceilings", "floors"];

/** One recorded exception: which measure, which key, and why it is allowed. */
export type BaselineEntry = {
  readonly section: string;
  readonly measure: string;
  readonly key: string;
  readonly reason: string | undefined;
};

/** Every recorded entry in the baseline, and none when there is no baseline. */
export function baselineEntries(context: DoctorContext): readonly BaselineEntry[] {
  const baseline = readBaseline(context);
  if (baseline === undefined) return [];
  return SECTIONS.flatMap((section) => entriesInSection(section, baseline[section]));
}

/** Every glob the baseline exempts from measurement. */
export function baselineExemptions(context: DoctorContext): readonly string[] {
  const baseline = readBaseline(context);
  const exempt: unknown = baseline?.["exempt"];
  return isUnknownArray(exempt) ? exempt.filter(isString) : [];
}

function readBaseline(context: DoctorContext): Record<string, unknown> | undefined {
  if (!context.exists(BASELINE_FILE)) return undefined;
  const parsed: unknown = JSON.parse(context.read(BASELINE_FILE));
  return isRecord(parsed) ? parsed : undefined;
}

function entriesInSection(section: string, measures: unknown): readonly BaselineEntry[] {
  if (!isRecord(measures)) return [];
  return Object.entries(measures).flatMap(([measure, keys]) =>
    isRecord(keys)
      ? Object.entries(keys).map(([key, entry]) => ({
          section,
          measure,
          key,
          reason: reasonOf(entry),
        }))
      : [],
  );
}

function reasonOf(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const reason: unknown = entry["reason"];
  return isString(reason) ? reason : undefined;
}
