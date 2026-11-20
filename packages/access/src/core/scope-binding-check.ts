import type { AccessModel } from "./access-model.js";
import { planScope, scopeSchema } from "./scope-plan.js";
import type { ScopePlanFailure, ScopeSchema } from "./scope-plan.js";

/** The permission a record list is scoped by. */
const LIST_PERMISSION = "view";

/**
 * Startup check over every registered record's scope bindings: its `view`
 * plan compiles, so every role it reaches is bound, every lookup lands on a
 * scope, every `via` lands on a bound record, and no rule loops. Opt-in by
 * presence: with no bindings registered it returns no failures.
 */
export function checkScopeBindings(
  model: AccessModel,
): readonly ScopePlanFailure[] {
  return checkScopeBindingsInSchema(scopeSchema(model));
}

export function checkScopeBindingsInSchema(
  schema: ScopeSchema,
): readonly ScopePlanFailure[] {
  const failures: ScopePlanFailure[] = [];

  for (const [wireName, roles] of schema.bindings) {
    const path = `${wireName}.${LIST_PERMISSION}`;
    const definition = schema.definitions.find(
      (entry) => entry.wireName === wireName,
    );
    if (definition === undefined) {
      failures.push({
        path,
        message: `scope bindings name ${wireName}, which has no access definition`,
      });
      continue;
    }
    const declaredKind = schema.kinds.get(wireName);
    if (declaredKind === "scope" || declaredKind === "catalog") {
      failures.push({
        path,
        message: `${wireName} is declared a ${declaredKind} but has record bindings`,
      });
    }
    for (const roleName of Object.keys(roles)) {
      if (!definition.roles.some((role) => role.name === roleName)) {
        failures.push({
          path,
          message: `scope bindings name role ${roleName}, which ${wireName} does not have`,
        });
      }
    }
    if (
      !definition.permissions.some(
        (permission) => permission.name === LIST_PERMISSION,
      )
    ) {
      failures.push({
        path,
        message: `${wireName} has scope bindings but no ${LIST_PERMISSION} permission`,
      });
      continue;
    }

    failures.push(...planScope(schema, wireName, LIST_PERMISSION).failures);
  }

  return failures;
}
