/**
 * Inline Rust test modules: ceiling 0.
 *
 * A `#[cfg(test)] mod tests { ... }` at the bottom of a production file is how
 * an oversized crate file grows: the tests are already there, so the next
 * behavior goes there too. The supported shape is `#[cfg(test)] mod tests;`
 * with a sibling `tests.rs`, which `test-files-over-ceiling` then budgets at
 * 600 on its own.
 *
 * A key is emitted for every candidate file, including the zeros, so a file
 * whose block has been moved out reads as being at the ceiling rather than as
 * a key nothing measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import {
  fileReading,
  type DoctorSignal,
  type SignalReading,
  type SignalReadings,
} from "../../doctor-signal.js";
import { isRustSource } from "../scanners/source-classification.js";

const INLINE_TEST_MODULE = /#\[cfg\(test\)\]\s*mod\s+tests\s*\{/g;

function countInlineTestModules(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!isRustSource(path) || path.endsWith("/tests.rs")) continue;
    const found = context.read(path).match(INLINE_TEST_MODULE);
    readings.set(path, fileReading(path, found === null ? 0 : found.length));
  }
  return readings;
}

export const rustInlineTestsSignal: DoctorSignal = {
  id: "rust-inline-tests",
  issue: "enmeshment",
  question: "In Rust, is there a `#[cfg(test)] mod tests` outside `tests.rs`?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Nobody in this family has a door.",
  measure: "rustInlineTests",
  run: (context) => Promise.resolve(countInlineTestModules(context)),
};
