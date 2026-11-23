/**
 * House rules longer than their recorded budget: ceiling 0.
 *
 * Everything an automated contributor is told costs it context it then does
 * not have for the change. That is the whole reason a budget exists: rules
 * nobody can afford to read are rules that get skimmed, and a skimmed rule is
 * a rule that is not enforced. An entrypoint that grew past its budget did not
 * become more binding; it became optional.
 *
 * The budgets are the repository's own numbers, read from the file it keeps
 * them in, and the token count is the same approximation that file's checker
 * uses — four characters to a token. A repository that records no budgets is
 * asked nothing here, because a budget Dad invented is a number nobody agreed
 * to.
 *
 * One key per file plus one for the whole skill library, present ones at zero,
 * so a failure names the document that grew rather than the budget it broke.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";

const BUDGETS_FILE = ".agents/instruction-budgets.json";
const SKILL_FILE = "SKILL.md";
const CHARACTERS_PER_TOKEN = 4;
const WORKFLOW_FRONTMATTER = /^role:\s*workflow\s*$/m;

type Budgets = {
  readonly entrypoint: string;
  readonly entrypointTokens: number;
  readonly directory: string;
  readonly perSkill: number;
  readonly perWorkflowSkill: number;
  readonly perReference: number;
  readonly total: number;
};

/** The token count the recorded budgets are written in. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value: unknown = record[key];
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

function readBudgets(context: DoctorContext): Budgets | undefined {
  if (!context.exists(BUDGETS_FILE)) return undefined;
  const parsed: unknown = JSON.parse(context.read(BUDGETS_FILE));
  const root = isRecord(parsed) ? parsed : {};
  const entrypoint: unknown = root["agentEntrypoint"];
  const skills: unknown = root["skills"];
  if (!isRecord(entrypoint) || !isRecord(skills)) return undefined;
  const path: unknown = entrypoint["path"];
  const directory: unknown = skills["directory"];
  if (!isString(path) || !isString(directory)) return undefined;
  return {
    entrypoint: path,
    entrypointTokens: numberAt(entrypoint, "maxApproximateTokens"),
    directory,
    perSkill: numberAt(skills, "maxApproximateTokensPerSkill"),
    perWorkflowSkill: numberAt(skills, "maxApproximateTokensPerWorkflowSkill"),
    perReference: numberAt(skills, "maxApproximateTokensPerSupportingReference"),
    total: numberAt(skills, "maxApproximateTokensTotal"),
  };
}

function budgetForInstruction(budgets: Budgets, path: string, text: string): number {
  if (!path.endsWith(`/${SKILL_FILE}`)) return budgets.perReference;
  return WORKFLOW_FRONTMATTER.test(text) ? budgets.perWorkflowSkill : budgets.perSkill;
}

function instructionFiles(context: DoctorContext, budgets: Budgets): readonly string[] {
  const prefix = `${budgets.directory}/`;
  return context.files().filter((path) => path.startsWith(prefix) && path.endsWith(".md"));
}

function countOverBudget(context: DoctorContext): SignalReadings {
  const budgets = readBudgets(context);
  if (budgets === undefined) return new Map();
  const readings = new Map<string, SignalReading>();
  if (context.exists(budgets.entrypoint)) {
    const tokens = approximateTokens(context.read(budgets.entrypoint));
    readings.set(budgets.entrypoint, {
      value: tokens > budgets.entrypointTokens ? 1 : 0,
      evidence: [{ path: budgets.entrypoint, name: `${String(tokens)} tokens` }],
    });
  }
  let library = 0;
  for (const path of instructionFiles(context, budgets)) {
    const text = context.read(path);
    const tokens = approximateTokens(text);
    if (path.endsWith(`/${SKILL_FILE}`)) library += tokens;
    readings.set(path, {
      value: tokens > budgetForInstruction(budgets, path, text) ? 1 : 0,
      evidence: [{ path, name: `${String(tokens)} tokens` }],
    });
  }
  readings.set(budgets.directory, {
    value: library > budgets.total ? 1 : 0,
    evidence: [{ path: budgets.directory, name: `${String(library)} tokens` }],
  });
  return readings;
}

export const entrypointOverBudgetSignal: DoctorSignal = {
  id: "entrypoint-over-budget",
  issue: "you-let-the-babysitter-raise-them",
  question: "Do the entrypoint or the skills exceed their recorded token budgets?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "He will read the whole repo to change one line.",
  run: (context) => Promise.resolve(countOverBudget(context)),
};
