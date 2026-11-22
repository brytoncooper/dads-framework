import { z } from "zod";

import {
  finalizeAccessModel,
  type AccessModel,
  type ResolvedAccessDefinition,
} from "./access-model.js";
import { both, excluding, gated, through, throughAll } from "./combinators.js";
import type { CompileAccessOptions } from "./dsl-resource-types.js";
import { entityHandle } from "./entity-handle.js";
import { wildcard, withExpiration, type SingleRoleValue } from "./holders.js";
import type {
  AccessIrDefinition,
  AccessIrRole,
  AccessIrSubject,
  AccessIrTerm,
} from "./ir.js";
import {
  permissionToken,
  roleToken,
  type PermissionTerm,
  type PermissionToken,
  type RoleHolder,
  type RoleToken,
} from "./refs.js";

const defaultIdSchema: z.ZodType<string> = z.string().min(1);

function lowerSubject(subject: AccessIrSubject): SingleRoleValue {
  let base: SingleRoleValue;
  if (subject.kind === "type") {
    base = entityHandle({
      wireName: subject.wireName,
      idSchema: defaultIdSchema,
    });
  } else if (subject.kind === "wildcard") {
    base = wildcard(
      entityHandle({ wireName: subject.wireName, idSchema: defaultIdSchema }),
    );
  } else {
    base = {
      kind: "userset",
      entityWireName: subject.wireName,
      roleName: subject.relation,
    };
  }
  return subject.expiration === true ? withExpiration(base) : base;
}

function lowerRoleHolder(role: AccessIrRole): RoleHolder {
  const lowered = role.subjects.map(lowerSubject);
  const [only] = lowered;
  return lowered.length === 1 && only !== undefined ? only : lowered;
}

function firstTargetWireName(
  roleDef: AccessIrRole | undefined,
  fallback: string,
): string {
  const firstType = roleDef?.subjects.find((entry) => entry.kind === "type");
  return firstType?.wireName ?? roleDef?.subjects[0]?.wireName ?? fallback;
}

function lowerArrowTerm(
  term: Extract<AccessIrTerm, { readonly kind: "through" | "through-all" }>,
  ownerWireName: string,
  roles: Readonly<Record<string, RoleToken>>,
  roleDefs: ReadonlyMap<string, AccessIrRole>,
): PermissionTerm {
  const role =
    roles[term.roleName] ?? roleToken(ownerWireName, term.roleName, []);
  const targetWire = firstTargetWireName(
    roleDefs.get(term.roleName),
    ownerWireName,
  );
  const target = permissionToken(targetWire, term.targetPermission);
  return term.kind === "through"
    ? through(role, target)
    : throughAll(role, target);
}

function lowerTerm(
  term: AccessIrTerm,
  ownerWireName: string,
  roles: Readonly<Record<string, RoleToken>>,
  roleDefs: ReadonlyMap<string, AccessIrRole>,
): PermissionTerm {
  if (term.kind === "role" || term.kind === "permission") {
    return roles[term.name] ?? permissionToken(ownerWireName, term.name);
  }
  if (term.kind === "through" || term.kind === "through-all") {
    return lowerArrowTerm(term, ownerWireName, roles, roleDefs);
  }
  if (term.kind === "or") {
    return {
      kind: "or",
      terms: term.terms.map((entry) =>
        lowerTerm(entry, ownerWireName, roles, roleDefs),
      ),
    };
  }
  if (term.kind === "gated") {
    return gated(
      lowerTerm(term.term, ownerWireName, roles, roleDefs),
      lowerTerm(term.condition, ownerWireName, roles, roleDefs),
    );
  }
  if (term.kind === "excluding") {
    return excluding(
      lowerTerm(term.term, ownerWireName, roles, roleDefs),
      lowerTerm(term.banned, ownerWireName, roles, roleDefs),
    );
  }
  return both(
    lowerTerm(term.left, ownerWireName, roles, roleDefs),
    lowerTerm(term.right, ownerWireName, roles, roleDefs),
  );
}

function lowerDefinition(
  definition: AccessIrDefinition,
): ResolvedAccessDefinition {
  const entity = entityHandle({
    wireName: definition.wireName,
    idSchema: defaultIdSchema,
  });
  const roles: Record<string, RoleToken> = {};
  const roleDefs = new Map<string, AccessIrRole>();
  for (const role of definition.roles) {
    roles[role.name] = roleToken(
      definition.wireName,
      role.name,
      lowerRoleHolder(role),
    );
    roleDefs.set(role.name, role);
  }

  const permissions: Record<string, PermissionToken> = {};
  const expressions: Record<string, readonly PermissionTerm[]> = {};
  for (const permission of definition.permissions) {
    permissions[permission.name] = permissionToken(
      definition.wireName,
      permission.name,
    );
    expressions[permission.name] = permission.terms.map((term) =>
      lowerTerm(term, definition.wireName, roles, roleDefs),
    );
  }

  return {
    entity,
    roles,
    permissions,
    expressions,
    granting: undefined,
    catalogOnly: [],
  };
}

/**
 * Lower parsed `AccessIrDefinition[]` (for example from `parseZed`) straight
 * into an `AccessModel`, validating bindings and lookup allowlists.
 */
export function compileAccessFromIr(
  definitions: readonly AccessIrDefinition[],
  options?: CompileAccessOptions,
): AccessModel {
  const seen = new Set<string>();
  const resolved: ResolvedAccessDefinition[] = [];
  for (const definition of definitions) {
    if (seen.has(definition.wireName)) {
      throw new Error(`duplicate access model entry ${definition.wireName}`);
    }
    seen.add(definition.wireName);
    resolved.push(lowerDefinition(definition));
  }
  return finalizeAccessModel(resolved, options);
}
