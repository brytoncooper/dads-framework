import {
  access,
  accessModel,
  asPermissionTerm,
  both,
  entityHandle,
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
  type RoleToken,
  type RoleValue,
  type SingleRoleValue,
} from "@dads-framework/access";
import { z } from "zod";

const DEFAULT_ID_SCHEMA = z.string().min(1);

/**
 * Reconstruct an in-memory `AccessModel` from parsed SpiceDB IR definitions
 * so `PostgresAuthorization` can evaluate permissions directly after a live
 * SpiceDB migration without executing generated TypeScript.
 */
export function buildAccessModelFromIr(
  definitions: readonly AccessIrDefinition[],
): AccessModel {
  const entities = buildEntityMap(definitions);
  const declarations = definitions.map((definition) =>
    buildAccessDeclaration(definition, entities),
  );
  return accessModel(declarations);
}

function buildEntityMap(
  definitions: readonly AccessIrDefinition[],
): ReadonlyMap<string, EntityHandle> {
  const entities = new Map<string, EntityHandle>();
  const ensure = (wireName: string): void => {
    if (!entities.has(wireName)) {
      entities.set(
        wireName,
        entityHandle({ wireName, idSchema: DEFAULT_ID_SCHEMA }),
      );
    }
  };

  for (const definition of definitions) {
    ensure(definition.wireName);
    for (const role of definition.roles) {
      for (const subject of role.subjects) {
        ensure(subject.wireName);
      }
    }
  }
  return entities;
}

function requireEntity(
  entities: ReadonlyMap<string, EntityHandle>,
  wireName: string,
): EntityHandle {
  const entity = entities.get(wireName);
  if (entity === undefined) {
    throw new Error(`Missing entity handle for "${wireName}"`);
  }
  return entity;
}

function buildSubjectHolder(
  subject: AccessIrSubject,
  entities: ReadonlyMap<string, EntityHandle>,
): SingleRoleValue {
  const entity = requireEntity(entities, subject.wireName);
  const base = buildBaseSubjectHolder(subject, entity);
  return subject.expiration === true ? withExpiration(base) : base;
}

function buildBaseSubjectHolder(
  subject: AccessIrSubject,
  entity: EntityHandle,
): SingleRoleValue {
  if (subject.kind === "type") return entity;
  if (subject.kind === "wildcard") return wildcard(entity);
  return membersOf(roleToken(subject.wireName, subject.relation, entity));
}

function buildRoleValue(
  role: AccessIrRole,
  entities: ReadonlyMap<string, EntityHandle>,
): RoleValue {
  const holders = role.subjects.map((subject) =>
    buildSubjectHolder(subject, entities),
  );
  const [only] = holders;
  if (holders.length === 1 && only !== undefined) return only;
  return holders;
}

function buildAccessDeclaration(
  definition: AccessIrDefinition,
  entities: ReadonlyMap<string, EntityHandle>,
) {
  const entity = requireEntity(entities, definition.wireName);
  const rolesSpec: Record<string, RoleValue> = {};
  for (const role of definition.roles) {
    rolesSpec[role.name] = buildRoleValue(role, entities);
  }

  return access(entity, {
    roles: rolesSpec,
    permissions: (roles) => buildPermissionExpressions(definition, roles),
  });
}

function buildPermissionExpressions(
  definition: AccessIrDefinition,
  roles: Record<string, RoleToken>,
): Record<string, readonly PermissionTerm[]> {
  const result: Record<string, readonly PermissionTerm[]> = {};
  for (const permission of definition.permissions) {
    result[permission.name] = permission.terms.map((term) =>
      buildPermissionTerm(definition, roles, term),
    );
  }
  return result;
}

function buildPermissionTerm(
  definition: AccessIrDefinition,
  roles: Record<string, RoleToken>,
  term: AccessIrTerm,
): PermissionTerm {
  switch (term.kind) {
    case "role":
      return resolveRoleToken(definition, roles, term.name);
    case "permission":
      return permissionToken(definition.wireName, term.name);
    case "through":
      return through(
        resolveRoleToken(definition, roles, term.roleName),
        permissionToken(definition.wireName, term.targetPermission),
      );
    case "through-all":
      return throughAll(
        resolveRoleToken(definition, roles, term.roleName),
        permissionToken(definition.wireName, term.targetPermission),
      );
    case "or":
      return asPermissionTerm(
        term.terms.map((entry) =>
          buildPermissionTerm(definition, roles, entry),
        ),
      );
    case "excluding":
      return excluding(
        buildPermissionTerm(definition, roles, term.term),
        buildPermissionTerm(definition, roles, term.banned),
      );
    case "both":
      return both(
        buildPermissionTerm(definition, roles, term.left),
        buildPermissionTerm(definition, roles, term.right),
      );
    case "gated":
      return gated(
        buildPermissionTerm(definition, roles, term.term),
        buildPermissionTerm(definition, roles, term.condition),
      );
  }
}

function resolveRoleToken(
  definition: AccessIrDefinition,
  roles: Record<string, RoleToken>,
  roleName: string,
): RoleToken {
  const token = roles[roleName];
  if (token === undefined) {
    throw new Error(
      `Permission on "${definition.wireName}" references unknown role "${roleName}"`,
    );
  }
  return token;
}
