import type { AccessModel } from "./access-model.js";

/**
 * Fail-closed guard for direct `lookupResources` calls on a resource type.
 *
 * - Returns `false` if `resourceType` has `scopeBindings` in `model.bindings`
 *   (scoped records must be filtered via their compiled scope plan, never via
 *   unbounded `lookupResources`).
 * - Returns `true` ONLY when `model.lookupResourceAllowlist` explicitly names
 *   `resourceType`.
 */
export function isLookupResourcesAllowed(
  model: AccessModel,
  resourceType: string,
): boolean {
  if (model.bindings.some((entry) => entry.entity.wireName === resourceType)) {
    return false;
  }
  return model.lookupResourceAllowlist?.includes(resourceType) ?? false;
}

/**
 * Whether `relation` on `resourceType` is a role the record's scope bindings
 * declare `sparse-direct`: a direct grant rare enough per caller that a scope
 * plan asks SpiceDB for those record ids directly. This is the one lawful
 * `lookupResources` on a record, named by the relation, never by the caller.
 */
export function isSparseDirectGrant(
  model: AccessModel,
  resourceType: string,
  relation: string,
): boolean {
  const bindings = model.bindings.find(
    (entry) => entry.entity.wireName === resourceType,
  );
  return bindings?.roles[relation]?.kind === "sparse-direct";
}
