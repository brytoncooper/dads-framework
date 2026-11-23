/**
 * The signals that read text and nothing dearer: the record, the rules, and
 * the places a command runs.
 *
 * Every reading here answers from `context.files()`, `context.read()`, and
 * `context.exists()`. None of them builds a TypeScript program, walks a
 * dependency graph, or shells out, which is what lets a repository with no
 * TypeScript in it — or one the doctor has been pointed at for the first time,
 * before anything is installed — still get most of a report.
 *
 * The order is the order the report prints: the issues in `DAD.md` order, and
 * within an issue the order the companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { readmeMissingSignal } from "../avoidant-attachment/readme-missing.js";
import { readmeNonconformantSignal } from "../avoidant-attachment/readme-nonconformant.js";
import { junkDrawerDirectoriesSignal } from "../you-repeat-the-cycle/junk-drawer-directories.js";
import { agentEntrypointMissingSignal } from "../you-let-the-babysitter-raise-them/agent-entrypoint-missing.js";
import { entrypointOverBudgetSignal } from "../you-let-the-babysitter-raise-them/entrypoint-over-budget.js";
import { agentHooksUnwiredSignal } from "../you-let-the-babysitter-raise-them/agent-hooks-unwired.js";
import { todoCheckPermissionSignal } from "../commitment-issues/todo-check-permission.js";
import { baselineEntriesWithoutReasonSignal } from "../gaslighting/baseline-entries-without-reason.js";
import { exemptGlobsSignal } from "../gaslighting/exempt-globs.js";
import { suppressionsWithoutDescriptionSignal } from "../gaslighting/suppressions-without-description.js";
import { suppressedViolationsSignal } from "../the-silent-treatment/suppressed-violations.js";
import { unusedSuppressionsSignal } from "../the-silent-treatment/unused-suppressions.js";
import { packagesWithoutSurfaceSignal } from "../failure-to-launch/packages-without-surface.js";
import { ciWithoutVerifySignal } from "../its-not-you-its-my-boundaries/ci-without-verify.js";
import { crossDomainForeignKeysSignal } from "../its-not-you-its-my-boundaries/cross-domain-foreign-keys.js";
import { rulesAtWarnSignal } from "../its-not-you-its-my-boundaries/rules-at-warn.js";
import { compilerFlagsOffSignal } from "../its-not-you-its-my-boundaries/compiler-flags-off.js";
import { noVerifyInScriptsSignal } from "../its-not-you-its-my-boundaries/no-verify-in-scripts.js";
import { forcePushInWorkflowsSignal } from "../its-not-you-its-my-boundaries/force-push-in-workflows.js";
import { hookRuntimeSignal } from "../dad-has-issues-too/hook-runtime.js";
import { guardsFailClosedSignal } from "../dad-has-issues-too/guards-fail-closed.js";

/** The twenty readings this lane added, in `DAD.md` order. */
export const TEXT_AND_PACKAGE_SIGNALS: readonly DoctorSignal[] = [
  readmeMissingSignal,
  readmeNonconformantSignal,
  junkDrawerDirectoriesSignal,
  agentEntrypointMissingSignal,
  entrypointOverBudgetSignal,
  agentHooksUnwiredSignal,
  todoCheckPermissionSignal,
  baselineEntriesWithoutReasonSignal,
  exemptGlobsSignal,
  suppressionsWithoutDescriptionSignal,
  suppressedViolationsSignal,
  unusedSuppressionsSignal,
  packagesWithoutSurfaceSignal,
  ciWithoutVerifySignal,
  rulesAtWarnSignal,
  compilerFlagsOffSignal,
  noVerifyInScriptsSignal,
  forcePushInWorkflowsSignal,
  crossDomainForeignKeysSignal,
  guardsFailClosedSignal,
  hookRuntimeSignal,
];
