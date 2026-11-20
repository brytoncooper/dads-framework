/**
 * The baseline file: reading it, and writing it back the same way every time.
 *
 * `.agents/source-budgets.json` is a committed file that a tool rewrites, so
 * the tool writes it the way Prettier would: a formatter that disagreed would
 * make every `--update` leave the tree dirty in a second, unrelated way. Sorted
 * sections, sorted keys, the number, then the `movedTo` a floor may carry, then
 * the reason, two-space indent, one
 * trailing newline — and an unchanged run therefore reproduces the file it
 * read, byte for byte, which is what lets the gate be run at any time without
 * a diff.
 *
 * The format is the one the source-budget ratchet wrote before the doctor
 * existed, unchanged: an adopting repository's baseline keeps working, and this
 * repository's own baseline crossed the migration without an edit.
 */

import { isRecord, isString } from "../parse-guards.js";
import type { DoctorContext } from "./doctor-context.js";
import {
  BASELINE_PATH,
  compareStrings,
  sortedKeys,
  type BaselineEntries,
  type BaselineEntry,
  type BaselineSections,
  type GateBaseline,
} from "./doctor-gate-model.js";

/** Prettier's default, and the only formatting opinion this file needs. */
const PRINT_WIDTH = 80;

const DEFAULT_COUNTED_LINES = "non-blank, non-comment";
const DEFAULT_EXEMPT = ["**/*.generated.ts", "**/dist/**"];

/** The field a section writes its number under. */
const CEILING_FIELD = "mark";
const FLOOR_FIELD = "floor";

/** A baseline for a repository that has recorded nothing yet. */
export function emptyBaseline(): GateBaseline {
  return {
    countedLines: DEFAULT_COUNTED_LINES,
    exempt: [...DEFAULT_EXEMPT],
    ceilings: new Map(),
    floors: new Map(),
  };
}

/** Reads the baseline, filling in every field an older file may not carry. */
export function readGateBaseline(context: DoctorContext): GateBaseline {
  if (!context.exists(BASELINE_PATH)) return emptyBaseline();
  return parseGateBaseline(context.read(BASELINE_PATH));
}

/** The baseline one document holds, whether it came from disk or from a ref. */
export function parseGateBaseline(text: string): GateBaseline {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return emptyBaseline();
  const countedLines: unknown = parsed["countedLines"];
  return {
    countedLines: isString(countedLines) ? countedLines : DEFAULT_COUNTED_LINES,
    exempt: readExempt(parsed["exempt"]),
    ceilings: readSections(parsed["ceilings"], CEILING_FIELD),
    floors: readSections(parsed["floors"], FLOOR_FIELD),
  };
}

function readExempt(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function readSections(value: unknown, field: string): BaselineSections {
  const sections = new Map<string, BaselineEntries>();
  if (!isRecord(value)) return sections;
  for (const [name, entries] of Object.entries(value)) {
    sections.set(name, readEntries(entries, field, name));
  }
  return sections;
}

/**
 * One section's entries. An entry with no number is not an exception anybody
 * can judge, so it is not read as one and its key is treated as unlisted; an
 * entry with no reason is read and fails, which is the point.
 */
function readEntries(
  value: unknown,
  field: string,
  section: string,
): BaselineEntries {
  const entries = new Map<string, BaselineEntry>();
  if (!isRecord(value)) return entries;
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const amount: unknown = entry[field];
    if (typeof amount !== "number") continue;
    const reason: unknown = entry["reason"];
    entries.set(key, {
      value: amount,
      reason: isString(reason) ? reason : undefined,
      ...readMovedTo(entry["movedTo"], field, `${section} ${key}`),
    });
  }
  return entries;
}

/**
 * The `movedTo` a floor entry may carry: the key in the same section its count
 * moved to. A ceiling entry is deleted once its key comes back under the
 * threshold, so a transfer means nothing there and the field is refused by
 * name; so is a value that is not a key, rather than being read as absent and
 * turning a fall nobody declared into a fall the file appears to declare.
 */
function readMovedTo(
  value: unknown,
  field: string,
  subject: string,
): { movedTo?: string } {
  if (value === undefined) return {};
  if (field !== FLOOR_FIELD) {
    throw new Error(
      `${BASELINE_PATH}: ${subject}: movedTo belongs to a floor entry.`,
    );
  }
  if (!isString(value) || value.trim().length === 0) {
    throw new Error(
      `${BASELINE_PATH}: ${subject}: movedTo must name another key in this section.`,
    );
  }
  return { movedTo: value };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * One serialization: sorted sections, sorted keys, two-space indent, trailing
 * newline. Prettier keeps an object broken once its first key is on its own
 * line, which is what `JSON.stringify` produces, and collapses an array that
 * fits the print width, which `JSON.stringify` never does — so only the arrays
 * need saying out loud.
 */
export function serializeBaseline(baseline: GateBaseline): string {
  const exempt = [...baseline.exempt].sort(compareStrings);
  const lines = [
    "{",
    `  "schemaVersion": 1,`,
    `  "countedLines": ${JSON.stringify(baseline.countedLines)},`,
    `  "exempt": ${printArray(exempt, '  "exempt": '.length)},`,
    `  "ceilings": ${printObject(plainSections(baseline.ceilings, CEILING_FIELD))},`,
    `  "floors": ${printObject(plainSections(baseline.floors, FLOOR_FIELD))}`,
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

/** An array on one line when it fits, one item per line when it does not. */
function printArray(values: readonly string[], columnsUsed: number): string {
  const inline = `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  if (columnsUsed + inline.length + ",".length <= PRINT_WIDTH) return inline;
  const items = values.map((value) => `    ${JSON.stringify(value)}`);
  return `[\n${items.join(",\n")}\n  ]`;
}

/** A section of the document, re-indented to sit one level in. */
function printObject(value: PlainSections): string {
  return JSON.stringify(value, null, 2).split("\n").join("\n  ");
}

type PlainEntry = Record<string, number | string>;
type PlainSections = Record<string, Record<string, PlainEntry>>;

/**
 * The sections as the file holds them: the number under its own field name,
 * the `movedTo` and the reason after it, and an entry with no reason written
 * without one so the
 * failure it causes survives a rewrite instead of being papered over. Whatever
 * the map holds is written, so the serialization is a function of the map and
 * a section is dropped where it is emptied rather than here.
 */
function plainSections(
  sections: BaselineSections,
  field: string,
): PlainSections {
  const plain: PlainSections = {};
  for (const name of sortedKeys(sections.keys())) {
    const entries = sections.get(name) ?? new Map<string, BaselineEntry>();
    const written: Record<string, PlainEntry> = {};
    for (const key of sortedKeys(entries.keys())) {
      written[key] = plainEntry(entries, key, field);
    }
    plain[name] = written;
  }
  return plain;
}

// ---------------------------------------------------------------------------
// What the baseline exempts
// ---------------------------------------------------------------------------

const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Glob matching for the baseline's `exempt` list. `**` crosses path
 * separators, `*` stays inside one segment, `?` is one character, and every
 * other character is literal. Deliberately small: the exempt list is a handful
 * of globs, not a gitignore dialect.
 */
export function matchesExemptGlob(path: string, glob: string): boolean {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 1;
      continue;
    }
    pattern += patternFor(glob.charAt(index));
  }
  return new RegExp(`^${pattern}$`).test(path);
}

function patternFor(character: string): string {
  if (character === "*") return "[^/]*";
  if (character === "?") return "[^/]";
  return character.replace(GLOB_SPECIALS, "\\$&");
}

function plainEntry(
  entries: BaselineEntries,
  key: string,
  field: string,
): PlainEntry {
  const entry = entries.get(key);
  const written: PlainEntry = {};
  if (entry === undefined) return written;
  written[field] = entry.value;
  if (entry.movedTo !== undefined) written["movedTo"] = entry.movedTo;
  if (entry.reason !== undefined) written["reason"] = entry.reason;
  return written;
}
