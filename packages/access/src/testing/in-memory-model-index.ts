import type { AccessModel } from "../core/access-model.js";
import { emitAccessIr } from "../core/emit-ir.js";
import type { AccessIrDefinition, AccessIrPermission, AccessIrRole, AccessIrTerm } from "../core/ir.js";

/** Normalized tuple stored inside `InMemoryAuthorization`. */
export type StoredAccessTuple = {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation: string;
  readonly subjectIsWildcard: boolean;
  readonly expiresAtMs: number | null;
};

/** Pre-indexed lookup tables compiled once from an `AccessModel`. */
export type IndexedAccessModel = {
  readonly definitions: ReadonlyMap<string, AccessIrDefinition>;
  readonly rolesByEntity: ReadonlyMap<string, ReadonlyMap<string, AccessIrRole>>;
  readonly permissionsByEntity: ReadonlyMap<string, ReadonlyMap<string, AccessIrPermission>>;
};

/** Build fast O(1) lookup maps over the lowered IR of an `AccessModel`. */
export function indexAccessModel(model: AccessModel): IndexedAccessModel {
  const definitions = new Map<string, AccessIrDefinition>();
  const rolesByEntity = new Map<string, ReadonlyMap<string, AccessIrRole>>();
  const permissionsByEntity = new Map<string, ReadonlyMap<string, AccessIrPermission>>();

  for (const definition of emitAccessIr(model)) {
    definitions.set(definition.wireName, definition);
    const roleMap = new Map<string, AccessIrRole>();
    for (const role of definition.roles) {
      roleMap.set(role.name, role);
    }
    rolesByEntity.set(definition.wireName, roleMap);

    const permissionMap = new Map<string, AccessIrPermission>();
    for (const permission of definition.permissions) {
      permissionMap.set(permission.name, permission);
    }
    permissionsByEntity.set(definition.wireName, permissionMap);
  }

  return { definitions, rolesByEntity, permissionsByEntity };
}

/** Deterministic unique key for deduplicating stored relationships. */
export function tupleStorageKey(tuple: {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation: string;
}): string {
  return [
    tuple.resourceType,
    tuple.resourceId,
    tuple.relation,
    tuple.subjectType,
    tuple.subjectId,
    tuple.subjectRelation,
  ].join("\0");
}

/** Format a human-readable shorthand for an IR permission term. */
export function describeIrTerm(term: AccessIrTerm): string {
  switch (term.kind) {
    case "role":
    case "permission":
      return term.name;
    case "through":
      return `${term.roleName}.${term.targetPermission}`;
    case "through-all":
      return `every(${term.roleName}).${term.targetPermission}`;
    case "gated":
      return `allOf(${describeIrTerm(term.term)}, ${describeIrTerm(term.condition)})`;
    case "both":
      return `allOf(${describeIrTerm(term.left)}, ${describeIrTerm(term.right)})`;
    case "excluding":
      return `${describeIrTerm(term.term)}.unless(${describeIrTerm(term.banned)})`;
    case "or":
      return `anyOf(${term.terms.map(describeIrTerm).join(", ")})`;
  }
}

/** Format a human-readable shorthand for a top-level permission expression. */
export function describePermissionTerms(terms: readonly AccessIrTerm[]): string {
  if (terms.length === 0) return "never";
  if (terms.length === 1) {
    const onlyTerm = terms[0];
    return onlyTerm === undefined ? "never" : describeIrTerm(onlyTerm);
  }
  return `anyOf(${terms.map(describeIrTerm).join(", ")})`;
}
