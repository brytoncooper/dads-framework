import type { AccessModel } from "@dads-framework/access";
import type { SqliteColumnRelationBinding } from "./policy/column-relations.js";
import {
  compileAccessPolicy,
  type CompiledSqliteAccessPolicy,
} from "./policy/compile-access-policy.js";

const compiledPolicyCache = new WeakMap<
  AccessModel,
  CompiledSqliteAccessPolicy
>();

export function getOrCompileSqlitePolicy(
  model: AccessModel,
  columnRelations?: readonly SqliteColumnRelationBinding[],
): CompiledSqliteAccessPolicy {
  if (columnRelations !== undefined && columnRelations.length > 0) {
    return compileAccessPolicy(model, columnRelations);
  }
  const cached = compiledPolicyCache.get(model);
  if (cached !== undefined) return cached;
  const compiled = compileAccessPolicy(model);
  compiledPolicyCache.set(model, compiled);
  return compiled;
}
