/**
 * The production file budget: 400 counted lines.
 *
 * A file is the smallest unit an agent loads, reviews, and edits. The budget
 * is a proxy for "one responsibility per file". It exists so that an agent
 * hits a hard stop before a file becomes the only place anything can go.
 *
 * Test files are excluded here because `test-files-over-ceiling` owns them at
 * 600. A Rust file's inline test module is deliberately *not* excluded: it
 * counts toward the production file, which is the pressure that moves it into
 * a sibling `tests.rs`.
 */

import type { DoctorContext } from "../../doctor-context.js";
import { fileReading, type DoctorSignal, type SignalReading, type SignalReadings } from "../../doctor-signal.js";
import { countCodeLines } from "../scanners/counted-lines.js";
import { budgetedSourceFiles, isTestSource } from "../scanners/source-classification.js";

function countProductionFileLines(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  const hasRootSourcePackage = context.packages().some(({ root }) => root === "src");
  for (const path of budgetedSourceFiles(context.files(), hasRootSourcePackage)) {
    if (isTestSource(path)) continue;
    readings.set(path, fileReading(path, countCodeLines(context.read(path), path)));
  }
  return readings;
}

export const filesOverCeilingSignal: DoctorSignal = {
  id: "files-over-ceiling",
  issue: "enmeshment",
  question: "Does any source file exceed 400 counted lines?",
  reads: "text",
  unit: "lines",
  direction: "ceiling",
  thresholds: { standard: 400, strict: 400 },
  sentence: "Three thousand lines in one bed. You call it cohesion.",
  measure: "fileLines",
  run: (context) => Promise.resolve(countProductionFileLines(context)),
};
