import type { ScopeLookupTarget, ScopePlan } from "./scope-plan.js";

/** One-line text form for tests, snapshots, and error messages. */
export function describeScopePlan(plan: ScopePlan): string {
  if (plan.kind === "lookup") {
    return `lookup(${plan.role}: ${plan.targetType}#${plan.targetPermission})`;
  }
  if (plan.kind === "via") {
    return `via(${plan.role}: ${plan.targetType}, ${describeScopePlan(plan.plan)})`;
  }
  if (plan.kind === "tag" || plan.kind === "direct") {
    return `${plan.kind}(${plan.role})`;
  }
  if (plan.kind === "not") {
    return `not(${describeScopePlan(plan.plan)})`;
  }
  return `${plan.kind}(${plan.plans.map(describeScopePlan).join(", ")})`;
}

/**
 * Every distinct SpiceDB question in a plan, including inside `via`, in
 * first-seen order, so each is asked once per request.
 */
export function distinctScopeLookups(
  plan: ScopePlan,
): readonly ScopeLookupTarget[] {
  const byKey = new Map<string, ScopeLookupTarget>();
  collectLookups(plan, byKey);
  return [...byKey.values()];
}

function collectLookups(
  plan: ScopePlan,
  byKey: Map<string, ScopeLookupTarget>,
): void {
  if (plan.kind === "lookup") {
    byKey.set(`${plan.targetType}#${plan.targetPermission}`, {
      targetType: plan.targetType,
      targetPermission: plan.targetPermission,
    });
    return;
  }
  if (plan.kind === "via" || plan.kind === "not") {
    collectLookups(plan.plan, byKey);
    return;
  }
  if (plan.kind === "any" || plan.kind === "all") {
    for (const child of plan.plans) {
      collectLookups(child, byKey);
    }
  }
}
