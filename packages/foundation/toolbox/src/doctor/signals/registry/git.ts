/**
 * The signals that read git history rather than the working tree.
 *
 * Nine readings, and every one of them is a question the file tree cannot
 * answer: how old a promise is, how long a mark has sat still, whether a
 * ceiling was ever raised, whether the last quarter was spent moving files
 * around. The working tree only ever says what is true now, and each of these
 * is about what has been true for how long.
 *
 * Two of the catalogue's rows are not new signals here. `hooks-uninstalled`
 * under "climbing out the window" is `hooks-not-wired`, and the companion folds
 * that essay section into "It's not you. It's my boundaries.", so there is no
 * second issue to be cross-listed under. `thresholds-raised` under "Dad has
 * issues too" is `marks-raised-in-history`, which carries that issue in its
 * `alsoUnder` and is measured once.
 *
 * They are ordered the way the report prints: the issues in `DAD.md` order, and
 * within an issue the order the companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { todoAgeSignal } from "../commitment-issues/todo-age.js";
import { nondeterministicGeneratedFilesSignal } from "../dad-has-issues-too/nondeterministic-generated-files.js";
import { stagnantDebtSignal } from "../dad-has-issues-too/stagnant-debt.js";
import { reorganizationChurnSignal } from "../failure-to-launch/reorganization-churn.js";
import { marksRaisedInHistorySignal } from "../gaslighting/marks-raised-in-history.js";
import { hooksNotWiredSignal } from "../its-not-you-its-my-boundaries/hooks-not-wired.js";
import { suppressionAgeSignal } from "../the-silent-treatment/suppression-age.js";
import { scriptureSignal } from "../you-are-looking-for-a-father-figure/scripture.js";
import { staleDocsSignal } from "../you-are-looking-for-a-father-figure/stale-docs.js";

/** The nine readings that need a history. */
export const GIT_SIGNALS: readonly DoctorSignal[] = [
  staleDocsSignal,
  scriptureSignal,
  todoAgeSignal,
  marksRaisedInHistorySignal,
  suppressionAgeSignal,
  reorganizationChurnSignal,
  hooksNotWiredSignal,
  stagnantDebtSignal,
  nondeterministicGeneratedFilesSignal,
];
