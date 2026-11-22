/** Lower parsed `AccessIrDefinition` values into a standard `AccessModel`. */

import {
  actor,
  asPermissionTerm,
  both,
  excluding,
  gated,
  membersOf,
  permissionToken,
  roleToken,
  through,
  throughAll,
  wildcard,
  withExpiration,
  type AccessIrDefinition,
  type AccessIrRole,
  type AccessIrSubject,
  type AccessIrTerm,
  type AccessModel,
  type EntityHandle,
  type PermissionTerm,
  type PermissionToken,
  type ResolvedAccessDefinition,
  type RoleToken,
  type SingleRoleValue,
} from "@dads-framework/access";

/**
 * Lower an array of access IR definitions (such as parsed `.zed` output) into
 * an `AccessModel` suitable for `formatAccessTree` and other model consumers.
 */
export function lowerIrToAccessModel(
  definitions: readonly AccessIrDefinition[],
): AccessModel {
  const handles = collectEntityHandles(definitions);
  const resolvedDefinitions = definitions.map((definition) =>
    lowerDefinition(definition, handles),
  );
  return {
    definitions: resolvedDefinitions,
    bindings: [],
    visibleRecordExceptions: [],
  };
}

function collectEntityHandles(
  definitions: readonly AccessIrDefinition[],
): Map<string, EntityHandle> {
  const handles = new Map<string, EntityHandle>();
  const ensureHandle = (wireName: string): void => {
    if (!handles.has(wireName)) {
      handles.set(wireName, actor(wireName).handle);
    }
  };
  for (const definition of definitions) {
    ensureHandle(definition.wireName);
    for (const role of definition.roles) {
      for (const subject of role.subjects) {
        ensureHandle(subject.wireName);
      }
    }
  }
  return handles;
}

function entityHandleFor(
  handles: ReadonlyMap<string, EntityHandle>,
  wireName: string,
): EntityHandle {
  return handles.get(wireName) ?? actor(wireName).handle;
}

function lowerSubject(
  subject: AccessIrSubject,
  handles: ReadonlyMap<string, EntityHandle>,
): SingleRoleValue {
  const targetHandle = entityHandleFor(handles, subject.wireName);
  let base: SingleRoleValue;
  if (subject.kind === "type") {
    base = targetHandle;
  } else if (subject.kind === "wildcard") {
    base = wildcard(targetHandle);
  } else {
    base = membersOf(
      roleToken(subject.wireName, subject.relation, targetHandle),
    );
  }
  return subject.expiration === true ? withExpiration(base) : base;
}

function lowerRoleTokens(
  definition: AccessIrDefinition,
  handles: ReadonlyMap<string, EntityHandle>,
): Record<string, RoleToken> {
  const tokens: Record<string, RoleToken> = {};
  for (const role of definition.roles) {
    const holders = role.subjects.map((subject) =>
      lowerSubject(subject, handles),
    );
    tokens[role.name] = roleToken(definition.wireName, role.name, holders);
  }
  return tokens;
}

function firstTargetWireName(
  role: AccessIrRole | undefined,
  fallback: string,
): string {
  return role?.subjects[0]?.wireName ?? fallback;
}

function lowerArrowTerm(
  term: Extract<AccessIrTerm, { readonly kind: "through" | "through-all" }>,
  definition: AccessIrDefinition,
  roles: Readonly<Record<string, RoleToken>>,
  entity: EntityHandle,
): PermissionTerm {
  const roleDef = definition.roles.find(
    (entry) => entry.name === term.roleName,
  );
  const roleRef =
    roles[term.roleName] ??
    roleToken(definition.wireName, term.roleName, entity);
  const targetWire = firstTargetWireName(roleDef, definition.wireName);
  const target = permissionToken(targetWire, term.targetPermission);
  return term.kind === "through"
    ? through(roleRef, target)
    : throughAll(roleRef, target);
}

function lowerTerm(
  term: AccessIrTerm,
  definition: AccessIrDefinition,
  roles: Readonly<Record<string, RoleToken>>,
  entity: EntityHandle,
): PermissionTerm {
  switch (term.kind) {
    case "role":
      return (
        roles[term.name] ?? roleToken(definition.wireName, term.name, entity)
      );
    case "permission":
      return permissionToken(definition.wireName, term.name);
    case "through":
    case "through-all":
      return lowerArrowTerm(term, definition, roles, entity);
    case "gated":
      return gated(
        lowerTerm(term.term, definition, roles, entity),
        lowerTerm(term.condition, definition, roles, entity),
      );
    case "excluding":
      return excluding(
        lowerTerm(term.term, definition, roles, entity),
        lowerTerm(term.banned, definition, roles, entity),
      );
    case "both":
      return both(
        lowerTerm(term.left, definition, roles, entity),
        lowerTerm(term.right, definition, roles, entity),
      );
    case "or":
      return asPermissionTerm(
        term.terms.map((entry) => lowerTerm(entry, definition, roles, entity)),
      );
  }
}

function lowerDefinition(
  definition: AccessIrDefinition,
  handles: ReadonlyMap<string, EntityHandle>,
): ResolvedAccessDefinition {
  const entity = entityHandleFor(handles, definition.wireName);
  const roles = lowerRoleTokens(definition, handles);
  const permissions: Record<string, PermissionToken> = {};
  const expressions: Record<string, readonly PermissionTerm[]> = {};

  for (const permission of definition.permissions) {
    permissions[permission.name] = permissionToken(
      definition.wireName,
      permission.name,
    );
    expressions[permission.name] = permission.terms.map((term) =>
      lowerTerm(term, definition, roles, entity),
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
