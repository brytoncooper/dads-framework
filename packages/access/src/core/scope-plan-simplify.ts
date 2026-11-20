import type { ScopePlan, ScopeViaPlan } from "./scope-plan.js";
import { describeScopePlan } from "./scope-plan-read.js";

/** Flatten same-kind children and drop repeats, keeping first-seen order. */
function uniqueChildren(kind: "any" | "all", plans: readonly ScopePlan[]) {
  const flat = plans.flatMap((plan) =>
    plan.kind === kind ? plan.plans : [plan],
  );
  const unique = new Map<string, ScopePlan>();
  for (const child of flat) {
    const text = describeScopePlan(child);
    if (!unique.has(text)) unique.set(text, child);
  }
  return [...unique.values()];
}

function joined(
  kind: "any" | "all",
  plans: readonly (ScopePlan | undefined)[],
): ScopePlan | undefined {
  const present = plans.filter((plan) => plan !== undefined);
  if (present.length !== plans.length) return undefined;
  const flat = uniqueChildren(kind, present);
  const merged = kind === "any" ? mergedVias(flat) : flat;
  const only = merged[0];
  return merged.length === 1 && only !== undefined
    ? only
    : { kind, plans: merged };
}

/**
 * Inside `any`, walks through the same role become one walk:
 * any(via(r, A), via(r, B)) = via(r, any(A, B)). Not done for `all`, where a
 * role with several rows could match A and B on different rows.
 */
function viaKey(plan: ScopeViaPlan): string {
  return `${plan.role}|${plan.targetType}`;
}

function viaGroups(plans: readonly ScopePlan[]): Map<string, ScopePlan[]> {
  const groups = new Map<string, ScopePlan[]>();
  for (const plan of plans) {
    if (plan.kind !== "via") continue;
    const key = viaKey(plan);
    const group = groups.get(key) ?? [];
    group.push(plan.plan);
    groups.set(key, group);
  }
  return groups;
}

function mergedVias(plans: readonly ScopePlan[]): readonly ScopePlan[] {
  const groups = viaGroups(plans);
  const merged: ScopePlan[] = [];
  for (const plan of plans) {
    if (plan.kind !== "via") {
      merged.push(plan);
      continue;
    }
    const key = viaKey(plan);
    const group = groups.get(key);
    if (group === undefined) continue;
    groups.delete(key);
    const inner = group.length === 1 ? plan.plan : anyOf(group);
    merged.push({ ...plan, plan: inner ?? plan.plan });
  }
  return merged;
}

export function anyOf(plans: readonly (ScopePlan | undefined)[]) {
  return joined("any", plans);
}

export function allOf(plans: readonly (ScopePlan | undefined)[]) {
  return joined("all", plans);
}

export function notOf(plan: ScopePlan): ScopePlan {
  return plan.kind === "not" ? plan.plan : { kind: "not", plan };
}
