/**
 * The seventeen daddy issues, in `DAD.md` order, as data.
 *
 * `DAD.md` is the essay and `docs/daddy-issues.md` is its reference companion:
 * the essay names a failure, the companion defines it, tests it with numbered
 * questions, and states the cure. This module is the machine-readable copy of
 * both, so the report Dad prints quotes the documents rather than paraphrasing
 * them. Every `sentence` is a verbatim slice of `DAD.md`; every `cure` and
 * every question is a verbatim slice of the companion.
 *
 * The entries are split across two sibling modules for one reason: the whole
 * catalog does not fit under the 400-line file ceiling this command measures.
 * `issue-catalog-attachment.ts` holds the first eight and
 * `issue-catalog-enforcement.ts` the last nine, in essay order across both.
 */

import { ATTACHMENT_ISSUES } from "./issue-catalog-attachment.js";
import { ENFORCEMENT_ISSUES } from "./issue-catalog-enforcement.js";

/**
 * The identity of one issue: the heading anchor it carries in both `DAD.md`
 * and `docs/daddy-issues.md`, which are the same string in both files.
 */
export type DaddyIssueId =
  | "daddy-issues"
  | "anxious-attachment"
  | "avoidant-attachment"
  | "disorganized-attachment"
  | "enmeshment"
  | "you-are-looking-for-a-father-figure"
  | "you-repeat-the-cycle"
  | "you-let-the-babysitter-raise-them"
  | "people-pleasing"
  | "you-stay-with-people-who-cannot-meet-you"
  | "commitment-issues"
  | "gaslighting"
  | "the-silent-treatment"
  | "failure-to-launch"
  | "its-not-you-its-my-boundaries"
  | "the-paper-wall"
  | "dad-has-issues-too";

/**
 * One numbered question from the companion's **Test.** list. A question names
 * the signals that answer it; the companion writes two ids for the questions
 * that ask about two hatches at once.
 */
export type DaddyIssueQuestion = {
  readonly signals: readonly string[];
  readonly text: string;
};

export type DaddyIssue = {
  readonly id: DaddyIssueId;
  readonly title: string;
  readonly anchor: string;
  readonly sentence: string;
  readonly questions: readonly DaddyIssueQuestion[];
  readonly cure: string;
};

/** Every issue, in the order `DAD.md` raises them. */
export const DADDY_ISSUES: readonly DaddyIssue[] = [
  ...ATTACHMENT_ISSUES,
  ...ENFORCEMENT_ISSUES,
];

/** The issue an id names, or `undefined` when nothing carries that id. */
export function findDaddyIssue(id: string): DaddyIssue | undefined {
  return DADDY_ISSUES.find((issue) => issue.id === id);
}
