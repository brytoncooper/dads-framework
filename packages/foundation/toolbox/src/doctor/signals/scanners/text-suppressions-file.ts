/**
 * The linter's suppressions file, read as a flat list of entries.
 *
 * The file is written and pruned by the linter itself, never by hand, so its
 * shape is the linter's: a map from file to a map from rule to the number of
 * violations that file is allowed to keep. Two readings under the silent
 * treatment divide it between them — the standing suppressions, and the ones
 * whose file is no longer there — and both need the same flattening.
 */

import { isRecord } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";

/** Where ESLint keeps the violations a repository has agreed to carry. */
export const SUPPRESSIONS_FILE = "eslint-suppressions.json";

/** One suppressed rule in one file, and how many violations it covers. */
export type SuppressionEntry = {
  readonly path: string;
  readonly rule: string;
  readonly count: number;
};

/** Every entry in the suppressions file, and none when there is no file. */
export function suppressionEntries(context: DoctorContext): readonly SuppressionEntry[] {
  if (!context.exists(SUPPRESSIONS_FILE)) return [];
  return suppressionEntriesIn(context.read(SUPPRESSIONS_FILE));
}

/**
 * The same flattening, over a document that did not come from the working
 * tree. The gate's `--base` comparison reads this file at two git refs and has
 * to count them the way the signals count the one on disk, or the two readings
 * would disagree about what the file says.
 */
export function suppressionEntriesIn(text: string): readonly SuppressionEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return [];
  return Object.entries(parsed).flatMap(([path, rules]) => entriesForFile(path, rules));
}

function entriesForFile(path: string, rules: unknown): readonly SuppressionEntry[] {
  if (!isRecord(rules)) return [];
  return Object.entries(rules).map(([rule, entry]) => ({
    path,
    rule,
    count: countOf(entry),
  }));
}

function countOf(entry: unknown): number {
  if (!isRecord(entry)) return 0;
  const count: unknown = entry["count"];
  return typeof count === "number" ? count : 0;
}
