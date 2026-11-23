export { checkScopeBindings, checkScopeBindingsInSchema } from "./core/scope-binding-check.js";
export { scopeBindings } from "./core/scope-bindings.js";
export type { RoleBinding, ScopeBindings, ScopeRoleBindings } from "./core/scope-bindings.js";
export { isLookupResourcesAllowed, isSparseDirectGrant } from "./core/scope-lookup-policy.js";
export {
  compileScopePlan,
  compileScopePlanInSchema,
  describeScopePlan,
  distinctScopeLookups,
  planScope,
  scopeSchema,
} from "./core/scope-plan.js";
export type {
  ScopeLookupPlan,
  ScopeLookupTarget,
  ScopePlan,
  ScopePlanFailure,
  ScopeSchema,
  ScopeViaPlan,
} from "./core/scope-plan.js";
