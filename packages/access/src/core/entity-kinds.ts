/**
 * Reads each registered entity's declared kind, for the guards that refuse a
 * record list built from every visible record id: route registration (a
 * `requiresVisible` on a record), the authorization port (a `lookupResources`
 * on a record), and the API's boot check (an entity with no kind at all).
 */
import type { EntityKind } from "./entity-handle.js";
import type { AccessModel } from "./access-model.js";

/**
 * The declared kind of a registered entity. A model with scope bindings is a
 * record whatever its handle says (the scope compiler reads it the same way);
 * an unregistered or undeclared entity answers `undefined`.
 */
export function entityKindOf(
  model: AccessModel,
  wireName: string,
): EntityKind | undefined {
  if (model.bindings.some((entry) => entry.entity.wireName === wireName)) {
    return "record";
  }
  return model.definitions.find((entry) => entry.entity.wireName === wireName)
    ?.entity.kind;
}

/** Every registered access definition whose handle declares no kind. */
export function entitiesWithoutKind(model: AccessModel): readonly string[] {
  return model.definitions
    .filter((definition) => definition.entity.kind === undefined)
    .map((definition) => definition.entity.wireName)
    .sort();
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
