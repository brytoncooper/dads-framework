import type { AccessModel } from "@dads-framework/access";
import { answerScope, planScopedList } from "@dads-framework/access/runtime";
import type { ScopePlan } from "@dads-framework/access/scopes";

import { HttpWiringError } from "../http-errors.js";
import type { ScopedAccess } from "../route/access.js";
import type { HttpRoute } from "../route/route-group.js";
import type { AccessDecision, AccessPorts } from "./enforce-access.js";
import { refuseVisibleRecordList } from "./refuse-visible-record-list.js";

/**
 * The scope questions, handled apart from the boolean table: resolve the
 * subject (401 without one), ask each distinct question of the compiled plan
 * once, in parallel, and allow with the answers. Empty answers are a valid
 * allow and are NOT short-circuited — the SQL decides, since one empty arm of
 * an `any` can still match.
 */
export async function enforceScope(
  access: ScopedAccess,
  subjects: Extract<AccessDecision, { outcome: "allow" }>,
  ports: AccessPorts,
  plan: ScopePlan | undefined,
): Promise<AccessDecision> {
  const subject = subjects.subject;
  if (subject === null) {
    return { outcome: "unauthenticated" };
  }
  if (plan === undefined) {
    // Enforced outside registerRoutes, which compiles the plan — loud 500.
    throw new HttpWiringError(
      `requiresScoped route for ${access.resourceType}.${access.permission} enforced without its compiled scope plan`,
    );
  }
  if (!ports.lookups) {
    throw new HttpWiringError(
      "requiresScoped route registered without a lookups port",
    );
  }
  const scope = await answerScope({
    resourceType: access.resourceType,
    permission: access.permission,
    plan,
    subject,
    lookups: ports.lookups,
  });
  return { ...subjects, scope, permission: access.permission };
}

/**
 * A scoped route's plan, compiled once as the route registers. A model whose
 * scope bindings cannot carry the permission refuses to register, so the API
 * cannot boot with a list it cannot scope. Only list routes render a scope.
 * A `requiresVisible` on a record refuses here too: it is the list a scope
 * plan exists to replace.
 */
export function compileRouteScopePlan(
  route: HttpRoute,
  model: AccessModel | undefined,
): ScopePlan | undefined {
  refuseVisibleRecordList(route, model);
  const access = route.access;
  if (access.kind !== "scoped") return undefined;
  if (route.kind === "raw-route") {
    throw new HttpWiringError(
      `raw route ${route.method} ${route.path} declares requiresScoped; only listRoute renders a scope`,
    );
  }
  if (model === undefined) {
    throw new HttpWiringError(
      `${route.method} ${route.path} uses requiresScoped without an access model`,
    );
  }
  try {
    return planScopedList(model, access.resourceType, access.permission);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpWiringError(
      `list route ${route.method} ${route.path} cannot be scoped: ${reason}`,
    );
  }
}
