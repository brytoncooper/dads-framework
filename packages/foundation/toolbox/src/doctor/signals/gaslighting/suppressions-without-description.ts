/**
 * Suppressions that do not say why: ceiling 0.
 *
 * The two hatches this counts are already held at zero by their own readings.
 * This one is a different question about the same text, and it is the question
 * that survives the exception being legitimate: when a repository does allow
 * one — in a negative type test, in a generated boundary — the description is
 * the whole of what makes it an exception rather than a silence. A hatch with
 * no words after it is a decision nobody has to defend, and the next reader
 * cannot tell whether it was thought about at all.
 *
 * Ten characters is the linter's own bar, and the reason it is a number rather
 * than a judgement is that `// x` and `-- fix` are what a bar of one produces.
 * The lint suppression is asked for the linter's description syntax — the
 * text after a double dash — and the type-checker suppression for anything at
 * all after the mark.
 *
 * The marks are joined at load time in `hatch-names.ts`, which explains why:
 * a module that spelled either one whole would be counted by the readings that
 * hold them at zero.
 *
 * A key is emitted for every TypeScript file, zeros included, so a file that
 * gains an unexplained hatch reports as being over rather than as a key
 * nothing measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { ESLINT_DISABLE_MARK, TS_EXPECT_ERROR_MARK, TS_IGNORE_MARK } from "../../hatch-names.js";
import { hasDescriptionAfter, scanComments, type SourceComment } from "../scanners/text-comment-scan.js";
import { isTypeScriptSource } from "../scanners/source-classification.js";

const LEAST_DESCRIPTION = 10;
const DESCRIPTION_SEPARATOR = " -- ";
const CHECKER_MARKS = [TS_EXPECT_ERROR_MARK, TS_IGNORE_MARK];

/** True when the comment carries a suppression nobody explained. */
export function isUndescribedSuppression(comment: string): boolean {
  if (comment.includes(ESLINT_DISABLE_MARK) && !hasDescriptionAfter(comment, DESCRIPTION_SEPARATOR, 1)) {
    return true;
  }
  return CHECKER_MARKS.some((mark) => comment.includes(mark) && !hasDescriptionAfter(comment, mark, LEAST_DESCRIPTION));
}

function undescribedIn(comments: readonly SourceComment[]): readonly SourceComment[] {
  return comments.filter((comment) => isUndescribedSuppression(comment.text));
}

function countUndescribedSuppressions(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!isTypeScriptSource(path)) continue;
    const found = undescribedIn(scanComments(context.read(path)));
    readings.set(path, {
      value: found.length,
      evidence: found.map((comment) => ({ path, line: comment.line })),
    });
  }
  return readings;
}

export const suppressionsWithoutDescriptionSignal: DoctorSignal = {
  id: "suppressions-without-description",
  issue: "gaslighting",
  question: `Is there an \`${ESLINT_DISABLE_MARK}\` with no reason, or a \`${TS_EXPECT_ERROR_MARK}\` whose description is under ten characters?`,
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "If you need the euphemism to live with it, you already know.",
  run: (context) => Promise.resolve(countUndescribedSuppressions(context)),
};
