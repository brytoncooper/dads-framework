/**
 * The signals phase zero shipped: everything answerable from the file tree.
 *
 * One registry module per lane, so a lane that adds signals edits the file
 * named for what its signals read and never the file another lane is editing.
 * This is the lane that was already here, and its order is the order the report
 * prints: the issues in `DAD.md` order, and within an issue the order the
 * companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { duplicatedHelpersSignal } from "../anxious-attachment/duplicated-helpers.js";
import { kindInversionsSignal } from "../anxious-attachment/kind-inversions.js";
import { docsConformancePackagesSignal } from "../avoidant-attachment/docs-conformance-packages.js";
import { invariantsFilesSignal } from "../avoidant-attachment/invariants-files.js";
import { soundnessCasesSignal } from "../commitment-issues/soundness-cases.js";
import { testCountSignal } from "../commitment-issues/test-count.js";
import { typeTestNegativeCasesSignal } from "../commitment-issues/type-test-negative-cases.js";
import { doctorCasesSignal } from "../dad-has-issues-too/doctor-cases.js";
import { lintSuppressionCommentsSignal } from "../daddy-issues/lint-suppression-comments.js";
import { tsSuppressionsSignal } from "../daddy-issues/ts-suppressions.js";
import { barrelImpuritySignal } from "../enmeshment/barrel-impurity.js";
import { clippyAllowsSignal } from "../enmeshment/clippy-allows.js";
import { filesOverCeilingSignal } from "../enmeshment/files-over-ceiling.js";
import { rustInlineTestsSignal } from "../enmeshment/rust-inline-tests.js";
import { testFilesOverCeilingSignal } from "../enmeshment/test-files-over-ceiling.js";
import { lintRulesSignal } from "../its-not-you-its-my-boundaries/lint-rules.js";

/** The sixteen signals that read text, packages, or a recorded command. */
export const FOUNDATION_SIGNALS: readonly DoctorSignal[] = [
  lintSuppressionCommentsSignal,
  tsSuppressionsSignal,
  kindInversionsSignal,
  duplicatedHelpersSignal,
  docsConformancePackagesSignal,
  invariantsFilesSignal,
  filesOverCeilingSignal,
  testFilesOverCeilingSignal,
  barrelImpuritySignal,
  clippyAllowsSignal,
  rustInlineTestsSignal,
  testCountSignal,
  typeTestNegativeCasesSignal,
  soundnessCasesSignal,
  lintRulesSignal,
  doctorCasesSignal,
];
