/**
 * Renders a scope plan, with its SpiceDB answers, as one SQL condition over
 * the record's own columns. The same condition serves the page query and its
 * `COUNT(*)`, so the total and the page can never disagree about scope.
 *
 * Every id set is one `uuid[]` parameter (`= ANY($n::uuid[])`), never an `IN`
 * list, so a large answer cannot reach Postgres's 65,535-parameter cap.
 */
import { sql, type SQL } from "drizzle-orm";

import type { ScopePlan } from "@dads-framework/access/scopes";

import { scopeQuestionKey, type ScopeAnswer } from "@dads-framework/access/runtime";
import type { RoleSql, ScopeSqlBindings } from "./scope-sql-bindings.js";

/**
 * The WHERE condition that keeps exactly the records the plan admits.
 * `bindings` are the listed record's own; a `via` renders the walked-to
 * record with matching bindings from `related`.
 */
export function scopePredicate(
  answer: ScopeAnswer,
  bindings: ScopeSqlBindings,
  related: readonly ScopeSqlBindings[] = [],
): SQL {
  if (bindings.wireName !== answer.resourceType) {
    throw new Error(`scope answer is for ${answer.resourceType} but the SQL bindings are for ${bindings.wireName}`);
  }
  return renderPlan(answer.plan, { answer, related }, bindings);
}

type Rendering = {
  readonly answer: ScopeAnswer;
  readonly related: readonly ScopeSqlBindings[];
};

function renderPlan(plan: ScopePlan, rendering: Rendering, bindings: ScopeSqlBindings): SQL {
  switch (plan.kind) {
    case "lookup":
      return renderLookup(
        roleSql(bindings, plan.role),
        idsParameter(rendering.answer, plan.targetType, plan.targetPermission),
        bindings,
        plan.role,
      );
    case "tag":
      return renderTag(roleSql(bindings, plan.role), bindings, plan.role);
    case "direct":
      return sql`${bindings.id} = ANY(${idsParameter(rendering.answer, bindings.wireName, plan.role)})`;
    case "via":
      return renderVia(plan.role, plan.targetType, plan.plan, rendering, bindings);
    case "any":
      return joined(plan.plans, " OR ", sql`FALSE`, rendering, bindings);
    case "all":
      return joined(plan.plans, " AND ", sql`TRUE`, rendering, bindings);
    case "not":
      // A NULL inside (a NULL column compared with ANY) is "no match", as an
      // absent tuple is in SpiceDB, so it must negate to TRUE, not to NULL.
      return sql`NOT COALESCE((${renderPlan(plan.plan, rendering, bindings)}), FALSE)`;
  }
}

function renderLookup(role: RoleSql, ids: SQL, bindings: ScopeSqlBindings, roleName: string): SQL {
  switch (role.kind) {
    case "scope-column":
      return sql`${role.column} = ANY(${ids})`;
    case "scope-join":
    case "derived":
      return sql`(${role.matches(ids)})`;
    case "tag":
      throw new Error(`${bindings.wireName} role ${roleName} is a tag, but the plan looks up scopes through it`);
  }
}

function renderTag(role: RoleSql, bindings: ScopeSqlBindings, roleName: string): SQL {
  if (role.kind !== "tag") {
    throw new Error(`${bindings.wireName} role ${roleName} is bound as ${role.kind}, but the plan uses it as a tag`);
  }
  return sql`(${role.condition})`;
}

/** The walked-to record matches the inner plan, joined on the role's column. */
function renderVia(
  roleName: string,
  targetType: string,
  inner: ScopePlan,
  rendering: Rendering,
  bindings: ScopeSqlBindings,
): SQL {
  const role = roleSql(bindings, roleName);
  if (role.kind !== "scope-column") {
    throw new Error(
      `${bindings.wireName} role ${roleName} walks into ${targetType}, so it must be bound as scope-column, not ${role.kind}`,
    );
  }
  const target = rendering.related.find((entry) => entry.wireName === targetType);
  if (target === undefined) {
    throw new Error(`${bindings.wireName} role ${roleName} walks into ${targetType}, which has no scope SQL bindings`);
  }
  if (target.table === bindings.table) {
    throw new Error(
      `${bindings.wireName} role ${roleName} walks into its own table; a self-walk needs a table alias this builder does not make`,
    );
  }
  return sql`EXISTS (SELECT 1 FROM ${target.table} WHERE ${target.id} = ${role.column} AND ${renderPlan(inner, rendering, target)})`;
}

function joined(
  plans: readonly ScopePlan[],
  separator: string,
  whenEmpty: SQL,
  rendering: Rendering,
  bindings: ScopeSqlBindings,
): SQL {
  if (plans.length === 0) {
    return whenEmpty;
  }
  const parts = plans.map((plan) => renderPlan(plan, rendering, bindings));
  return sql`(${sql.join(parts, sql.raw(separator))})`;
}

function roleSql(bindings: ScopeSqlBindings, roleName: string): RoleSql {
  const role = bindings.roles[roleName];
  if (role === undefined) {
    throw new Error(`${bindings.wireName} role ${roleName} has no scope SQL binding`);
  }
  return role;
}

/** One question's answer as a single `uuid[]` parameter. */
function idsParameter(answer: ScopeAnswer, resourceType: string, permission: string): SQL {
  const ids = answer.idsByQuestion.get(scopeQuestionKey({ resourceType, permission }));
  if (ids === undefined) {
    throw new Error(
      `scope answer has no ids for ${resourceType}#${permission}; build it with answerScope for the same plan`,
    );
  }
  return sql`${sql.param([...ids])}::uuid[]`;
}
