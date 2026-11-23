/**
 * Type-checker suppressions outside `type-tests/`: ceiling 0.
 *
 * Inside a `type-tests/` directory the expect-error comment is the assertion
 * itself — it is how a negative type test states that an authoring mistake
 * must not compile, and `type-test-negative-cases` puts a floor under how many
 * of them there are. Anywhere else it is the same move as `as any`: the
 * compiler found something and the code told it to be quiet.
 *
 * The ignore comment is counted alongside it because it is the same
 * suppression without the safety of failing when it stops being needed.
 */

import type { DoctorContext } from "../../doctor-context.js";
import { fileReading, type DoctorSignal, type SignalReading, type SignalReadings } from "../../doctor-signal.js";
import { TS_EXPECT_ERROR_MARK, TS_IGNORE_MARK } from "../../hatch-names.js";
import { isTypeScriptSource } from "../scanners/source-classification.js";

const MARKS = [TS_EXPECT_ERROR_MARK, TS_IGNORE_MARK];
const TYPE_TEST_DIRECTORY = "/type-tests/";

function countTypeSuppressions(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!isTypeScriptSource(path)) continue;
    if (path.includes(TYPE_TEST_DIRECTORY)) continue;
    const text = context.read(path);
    const found = MARKS.reduce((total, mark) => total + text.split(mark).length - 1, 0);
    readings.set(path, fileReading(path, found));
  }
  return readings;
}

export const tsSuppressionsSignal: DoctorSignal = {
  id: "ts-suppressions",
  issue: "daddy-issues",
  question: `Is there a \`${TS_IGNORE_MARK}\` or \`@ts-nocheck\`, or a \`${TS_EXPECT_ERROR_MARK}\` outside a \`type-tests/\` directory?`,
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "That is not a boundary. That is refusing to talk about it.",
  measure: "tsExpectErrorOutsideTypeTests",
  run: (context) => Promise.resolve(countTypeSuppressions(context)),
};
