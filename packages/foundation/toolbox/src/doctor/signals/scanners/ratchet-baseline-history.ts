/**
 * The ratchet baseline as its own history describes it.
 *
 * Two questions in this lane are about the same file over time rather than the
 * same file today: has a mark ever moved the wrong way, and how long has a mark
 * sat still. Both need the entries of every committed revision of
 * `.agents/source-budgets.json`, so the revisions are read and parsed once here
 * and the two signals differ only in what they do with the sequence.
 *
 * An entry is one measure's one key, in one of the two sections. A ceiling
 * records a `mark` that may only fall and a floor records a `floor` that may
 * only rise, so "loosening" is a direction and not a magnitude, and this module
 * gives every entry the direction its section implies. The one exception is
 * stated here too: a floor that fell may say where its count went, and a fall
 * whose named key rose by at least as much in the same diff is a split rather
 * than a loosening. That is the whole of the ratchet's own rule, stated once,
 * so a signal never has to remember which way a number is allowed to go.
 *
 * A workspace with no baseline is not a workspace with a clean one, and the
 * signals say so by name: nothing here invents an empty baseline to count zero
 * against.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import { readFileAtRevision, readPathRevisions, type GitRevision } from "./git-history.js";

/** The file the source budgets are recorded in, in every adopting repository. */
export const BASELINE_PATH = ".agents/source-budgets.json";

/** The failure the baseline signals report when there is nothing recorded. */
export const NO_RATCHET_BASELINE = "no ratchet baseline";

/** The section a count may move within: only a floor is ever transferred. */
const FLOORS = "floors";

const SECTIONS = [
  { section: "ceilings", field: "mark" },
  { section: FLOORS, field: "floor" },
];

/** One recorded mark: where it sits, what it says, and which way it may move. */
export type BaselineEntry = {
  /** `ceilings/<measure>/<key>` or `floors/<measure>/<key>`. */
  readonly key: string;
  readonly value: number;
  readonly section: string;
  /** Absent when the revision recorded none, which no fall may excuse. */
  readonly reason: string | undefined;
  /** The key a floor said its count moved to, under the same section path. */
  readonly movedTo: string | undefined;
};

/** One committed revision of the baseline, with the entries it recorded. */
export type BaselineRevision = {
  readonly revision: GitRevision;
  readonly entries: ReadonlyMap<string, BaselineEntry>;
};

/**
 * True when the move from `earlier` to `later` is the direction the ratchet
 * forbids: a ceiling that rose, or a floor that fell.
 */
export function isLoosening(earlier: number, later: number, section: string): boolean {
  return section === "ceilings" ? later > earlier : later < earlier;
}

/**
 * True when a floor that fell between two revisions said where its count went
 * and the arithmetic holds: the entry names another key under the same section
 * path, still carries a reason, and that key rose in this same pair of
 * revisions by at least the fall — a key the earlier revision did not record
 * counting as zero. A split declared this way is a floor that moved, not one
 * that fell, and it is the only fall this module does not call a loosening.
 */
export function transferCoversFall(
  entry: BaselineEntry,
  fall: number,
  later: ReadonlyMap<string, BaselineEntry>,
  earlier: ReadonlyMap<string, BaselineEntry>,
): boolean {
  if (entry.section !== FLOORS) return false;
  const movedTo = entry.movedTo;
  if (movedTo === undefined || movedTo === entry.key) return false;
  if ((entry.reason ?? "").trim().length === 0) return false;
  const destination = later.get(movedTo);
  if (destination === undefined) return false;
  return destination.value - (earlier.get(movedTo)?.value ?? 0) >= fall;
}

/** Every entry one revision of the baseline recorded, keyed by section path. */
export function readBaselineEntries(text: string): ReadonlyMap<string, BaselineEntry> {
  const entries = new Map<string, BaselineEntry>();
  const parsed = parseBaseline(text);
  if (parsed === undefined) return entries;
  for (const { section, field } of SECTIONS) {
    collectSection(entries, parsed[section], section, field);
  }
  return entries;
}

function parseBaseline(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectSection(entries: Map<string, BaselineEntry>, value: unknown, section: string, field: string): void {
  if (!isRecord(value)) return;
  for (const [measure, keys] of Object.entries(value)) {
    if (!isRecord(keys)) continue;
    for (const [key, entry] of Object.entries(keys)) {
      const mark = isRecord(entry) ? entry[field] : undefined;
      if (typeof mark !== "number") continue;
      const path = `${section}/${measure}/${key}`;
      entries.set(path, {
        key: path,
        value: mark,
        section,
        reason: textField(entry, "reason"),
        movedTo: sectionPath(section, measure, textField(entry, "movedTo")),
      });
    }
  }
}

function textField(entry: unknown, field: string): string | undefined {
  const value: unknown = isRecord(entry) ? entry[field] : undefined;
  return isString(value) ? value : undefined;
}

/**
 * A `movedTo` as the rest of this module keys entries. It names a key in the
 * entry's own section, so it is read under the same section path and a name
 * that reaches outside one simply matches nothing.
 */
function sectionPath(section: string, measure: string, key: string | undefined): string | undefined {
  return key === undefined ? undefined : `${section}/${measure}/${key}`;
}

/**
 * Every committed revision of the baseline, newest first, already parsed. A
 * revision whose file cannot be read is dropped rather than treated as empty,
 * because an unreadable revision is not a revision that recorded nothing.
 */
export function readBaselineHistory(root: string): readonly BaselineRevision[] {
  return readPathRevisions(root, BASELINE_PATH).flatMap((revision) => {
    const text = readFileAtRevision(root, revision.sha, BASELINE_PATH);
    if (text === undefined) return [];
    return [{ revision, entries: readBaselineEntries(text) }];
  });
}

/**
 * The date one entry's mark last moved, or the date it was first recorded.
 * Revisions arrive newest first, so the first pair that disagrees about the
 * value is the most recent move.
 */
export function lastMoveDate(history: readonly BaselineRevision[], key: string): string | undefined {
  let introduced: string | undefined;
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index]?.entries.get(key);
    if (current === undefined) break;
    introduced = history[index]?.revision.date;
    const older = history[index + 1]?.entries.get(key);
    if (older === undefined) break;
    if (older.value !== current.value) return history[index]?.revision.date;
  }
  return introduced;
}
