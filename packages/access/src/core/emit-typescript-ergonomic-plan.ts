import type { AccessIrDefinition, AccessIrPermission, AccessIrRole, AccessIrTerm } from "./ir.js";
import { childIrTermsOf } from "./emit-typescript-ergonomic-terms.js";
import type { ErgonomicSymbols } from "./emit-typescript-symbols.js";

export type ResourcePlan = {
  readonly definition: AccessIrDefinition;
  readonly recursive: boolean;
  readonly parentWireNames: readonly string[];
  readonly explicitRoles: readonly AccessIrRole[];
  readonly emittedPermissions: readonly AccessIrPermission[];
};

function termReferencesRole(term: AccessIrTerm, roleName: string): boolean {
  if (term.kind === "role" || term.kind === "permission") {
    return term.name === roleName;
  }
  if (term.kind === "through" || term.kind === "through-all") {
    return term.roleName === roleName;
  }
  return childIrTermsOf(term).some((child) => termReferencesRole(child, roleName));
}

function stripSelfParentThrough(permission: AccessIrPermission): AccessIrPermission | undefined {
  let stripped = false;
  const remaining: AccessIrTerm[] = [];
  for (const term of permission.terms) {
    const isSelfParentArrow =
      !stripped && term.kind === "through" && term.roleName === "parent" && term.targetPermission === permission.name;
    if (isSelfParentArrow) {
      stripped = true;
    } else {
      remaining.push(term);
    }
  }
  if (!stripped || remaining.length === 0) {
    return undefined;
  }
  if (remaining.some((term) => termReferencesRole(term, "parent"))) {
    return undefined;
  }
  return { name: permission.name, terms: remaining };
}

function extractRecursiveParentWireNames(
  parentRole: AccessIrRole,
  selfWireName: string,
  symbols: ErgonomicSymbols,
  declared: ReadonlySet<string>,
): readonly string[] | undefined {
  let hasSelf = false;
  const parentWireNames: string[] = [];
  for (const subject of parentRole.subjects) {
    if (subject.kind !== "type" || subject.expiration === true) {
      return undefined;
    }
    if (subject.wireName === selfWireName) {
      hasSelf = true;
      continue;
    }
    if (symbols.actorWireNames.has(subject.wireName) || !declared.has(subject.wireName)) {
      return undefined;
    }
    parentWireNames.push(subject.wireName);
  }
  return hasSelf ? parentWireNames : undefined;
}

function planRecursiveResource(
  definition: AccessIrDefinition,
  symbols: ErgonomicSymbols,
  declared: ReadonlySet<string>,
): ResourcePlan | undefined {
  const parentRole = definition.roles.find((role) => role.name === "parent");
  if (parentRole === undefined) return undefined;

  const parentWireNames = extractRecursiveParentWireNames(parentRole, definition.wireName, symbols, declared);
  if (parentWireNames === undefined) return undefined;

  const emittedPermissions: AccessIrPermission[] = [];
  for (const permission of definition.permissions) {
    const stripped = stripSelfParentThrough(permission);
    if (stripped === undefined) return undefined;
    emittedPermissions.push(stripped);
  }

  return {
    definition,
    recursive: true,
    parentWireNames,
    explicitRoles: definition.roles.filter((role) => role.name !== "parent"),
    emittedPermissions,
  };
}

function collectLazyTargetsForRoles(
  roles: readonly AccessIrRole[],
  declared: ReadonlySet<string>,
  lazyTargets: Set<string>,
): void {
  for (const role of roles) {
    for (const subject of role.subjects) {
      if (subject.kind === "type" && subject.expiration !== true && !declared.has(subject.wireName)) {
        lazyTargets.add(subject.wireName);
      }
    }
  }
}

/**
 * Plan each resource's emission shape (`recursive: true`, `parents`, explicit
 * roles/permissions) and identify forward/self lazy thunk targets.
 */
export function planResourcesAndLazyTargets(
  orderedResources: readonly AccessIrDefinition[],
  symbols: ErgonomicSymbols,
): {
  readonly plans: readonly ResourcePlan[];
  readonly lazyTargets: ReadonlySet<string>;
} {
  const declared = new Set<string>(symbols.actorWireNames);
  const lazyTargets = new Set<string>();
  const plans: ResourcePlan[] = [];

  for (const definition of orderedResources) {
    const recursivePlan = planRecursiveResource(definition, symbols, declared);
    const plan: ResourcePlan = recursivePlan ?? {
      definition,
      recursive: false,
      parentWireNames: [],
      explicitRoles: definition.roles,
      emittedPermissions: definition.permissions,
    };
    plans.push(plan);
    collectLazyTargetsForRoles(plan.explicitRoles, declared, lazyTargets);
    declared.add(definition.wireName);
  }

  return { plans, lazyTargets };
}
