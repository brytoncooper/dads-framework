/**
 * Suppressed clippy lints in production Rust: ceiling 0.
 *
 * A workspace that denies `too_many_lines`, `unwrap_used`, `panic` and friends
 * has one escape hatch left, and an escape hatch nobody counts becomes the
 * default. Recording each one turns "we allowed this" into a line in the
 * baseline with a reason and a name, and the ratchet makes removing one
 * permanent.
 *
 * Test modules are excluded on purpose: they carry a blanket inner attribute
 * at the module head, which is the intended shape and not an exception worth
 * counting. The inner-attribute form is also excluded by the literal being
 * matched, which begins with the outer form.
 */

import type { DoctorContext } from "../../doctor-context.js";
import {
  fileReading,
  type DoctorSignal,
  type SignalReading,
  type SignalReadings,
} from "../../doctor-signal.js";
import { isRustSource } from "../scanners/source-classification.js";

const ALLOW = "#[allow(clippy::";
const CFG_TEST = /#\[cfg\(test\)\]/;

function braceDelta(line: string): number {
  return line.split("{").length - line.split("}").length;
}

type AllowScan = {
  readonly count: number;
  readonly depth: number;
  readonly armed: boolean;
};

function scanTestModuleLine(line: string, scan: AllowScan): AllowScan {
  const delta = braceDelta(line);
  if (delta > 0) return { count: scan.count, depth: delta, armed: false };
  return {
    count: scan.count,
    depth: 0,
    armed: !line.trimEnd().endsWith(";"),
  };
}

/**
 * Counts allows outside `#[cfg(test)]` modules by tracking brace depth from
 * the module's opening brace. Braces inside strings and comments are not
 * excluded; a scanner is enough here because the shape being skipped is a
 * module body, not an expression.
 */
export function countProductionAllows(text: string): number {
  let scan: AllowScan = { count: 0, depth: 0, armed: false };
  for (const line of text.split("\n")) {
    if (scan.depth > 0) {
      const depth = Math.max(0, scan.depth + braceDelta(line));
      scan = { count: scan.count, depth, armed: scan.armed };
      continue;
    }
    if (scan.armed) {
      const delta = braceDelta(line);
      if (delta > 0) {
        scan = { count: scan.count, depth: delta, armed: false };
        continue;
      }
      if (line.includes(";")) scan = { ...scan, armed: false };
    }
    if (CFG_TEST.test(line)) {
      scan = scanTestModuleLine(line, scan);
      continue;
    }
    scan = { ...scan, count: scan.count + line.split(ALLOW).length - 1 };
  }
  return scan.count;
}

function countClippyAllows(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!isRustSource(path)) continue;
    readings.set(
      path,
      fileReading(path, countProductionAllows(context.read(path))),
    );
  }
  return readings;
}

export const clippyAllowsSignal: DoctorSignal = {
  id: "clippy-allows",
  issue: "enmeshment",
  question: "In Rust, is there an `#[allow(clippy::` mark in production?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "The compiler is not confused. The compiler is the only one being honest with you.",
  measure: "clippyAllows",
  run: (context) => Promise.resolve(countClippyAllows(context)),
};
