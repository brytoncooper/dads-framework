/**
 * The test file budget: 600 counted lines.
 *
 * Tests get more room than production code because a suite is a list of cases
 * and a list is allowed to be long. They still get a ceiling, because a 1200
 * line suite hides which behaviors are covered as surely as a 1200 line module
 * hides which responsibilities it has.
 *
 * The classification is shared with `files-over-ceiling`, so every budgeted
 * file lands under exactly one of the two ceilings.
 */

import type { DoctorContext } from "../../doctor-context.js";
import {
  fileReading,
  type DoctorSignal,
  type SignalReading,
  type SignalReadings,
} from "../../doctor-signal.js";
import { countCodeLines } from "../scanners/counted-lines.js";
import {
  budgetedSourceFiles,
  isTestSource,
} from "../scanners/source-classification.js";

function countTestFileLines(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  const hasRootSourcePackage = context
    .packages()
    .some(({ root }) => root === "src");
  for (const path of budgetedSourceFiles(
    context.files(),
    hasRootSourcePackage,
  )) {
    if (!isTestSource(path)) continue;
    readings.set(
      path,
      fileReading(path, countCodeLines(context.read(path), path)),
    );
  }
  return readings;
}

export const testFilesOverCeilingSignal: DoctorSignal = {
  id: "test-files-over-ceiling",
  issue: "enmeshment",
  question: "Does any test file exceed 600 counted lines?",
  reads: "text",
  unit: "lines",
  direction: "ceiling",
  thresholds: { standard: 600, strict: 600 },
  sentence: "Ask the file what it does and it says “stuff.”",
  measure: "testFileLines",
  run: (context) => Promise.resolve(countTestFileLines(context)),
};
