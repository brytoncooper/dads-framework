/**
 * The SpiceDB half of a scoped record list: compile the permission's scope
 * plan once, then per request ask each distinct scope question once and keep
 * the answers by question. The SQL half (`scopePredicate`) renders the plan
 * against those answers; nothing here touches a table.
 */
import type { AccessModel } from "../index.js";
import { compileScopePlan, type ScopePlan } from "../scopes.js";

import type { ResourceLookup, SubjectRef } from "./authorization.js";

/** One question SpiceDB answers for a plan: which ids of `resourceType` the caller may `permission`. */
export type ScopeQuestion = {
  readonly resourceType: string;
  readonly permission: string;
};

/**
 * Everything a list handler needs to render its scope as SQL: the compiled
 * plan, who asked, and each question's answer keyed by `scopeQuestionKey`.
 */
export type ScopeAnswer = {
  readonly resourceType: string;
  readonly permission: string;
  readonly plan: ScopePlan;
  readonly subject: SubjectRef;
  readonly idsByQuestion: ReadonlyMap<string, readonly string[]>;
};

/** The port `answerScope` asks through; `Authorization` satisfies it. */
export type ScopeLookups = {
  lookupResources(query: ResourceLookup): Promise<readonly string[]>;
};

export function scopeQuestionKey(question: ScopeQuestion): string {
  return `${question.resourceType}#${question.permission}`;
}

/**
 * Compile the scope plan for a list of `resourceType` by `permission`. Throws,
 * naming every rule path that cannot be compiled, so a list on a model whose
 * bindings cannot carry its rules refuses to register.
 */
export function planScopedList(
  model: AccessModel,
  resourceType: string,
  permission: string,
): ScopePlan {
  return compileScopePlan(model, resourceType, permission);
}

/**
 * Every distinct question a plan needs answered, in first-seen order: each
 * scope lookup, plus each sparse direct grant asked on the record it sits on
 * (inside a `via`, that is the walked-to record).
 */
export function scopeQuestions(
  plan: ScopePlan,
  resourceType: string,
): readonly ScopeQuestion[] {
  const byKey = new Map<string, ScopeQuestion>();
  collectQuestions(plan, resourceType, byKey);
  return [...byKey.values()];
}

function collectQuestions(
  plan: ScopePlan,
  resourceType: string,
  byKey: Map<string, ScopeQuestion>,
): void {
  switch (plan.kind) {
    case "lookup":
      remember(byKey, {
        resourceType: plan.targetType,
        permission: plan.targetPermission,
      });
      return;
    case "direct":
      remember(byKey, { resourceType, permission: plan.role });
      return;
    case "via":
      collectQuestions(plan.plan, plan.targetType, byKey);
      return;
    case "not":
      collectQuestions(plan.plan, resourceType, byKey);
      return;
    case "any":
    case "all":
      for (const child of plan.plans) {
        collectQuestions(child, resourceType, byKey);
      }
      return;
    case "tag":
      return;
  }
}

function remember(
  byKey: Map<string, ScopeQuestion>,
  question: ScopeQuestion,
): void {
  const key = scopeQuestionKey(question);
  if (!byKey.has(key)) {
    byKey.set(key, question);
  }
}

/**
 * Ask every question the plan needs, in parallel, once each. An empty answer
 * is kept, not short-circuited: an `any` with one empty arm can still match.
 */
export async function answerScope(input: {
  readonly resourceType: string;
  readonly permission: string;
  readonly plan: ScopePlan;
  readonly subject: SubjectRef;
  readonly lookups: ScopeLookups;
}): Promise<ScopeAnswer> {
  const questions = scopeQuestions(input.plan, input.resourceType);
  const answers = await Promise.all(
    questions.map(
      async (question): Promise<readonly [string, readonly string[]]> => {
        const ids = await input.lookups.lookupResources({
          subject: input.subject,
          permission: question.permission,
          resourceType: question.resourceType,
        });
        return [scopeQuestionKey(question), ids];
      },
    ),
  );
  return {
    resourceType: input.resourceType,
    permission: input.permission,
    plan: input.plan,
    subject: input.subject,
    idsByQuestion: new Map(answers),
  };
}
