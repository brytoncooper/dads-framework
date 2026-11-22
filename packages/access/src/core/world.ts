import type { DslNode } from "./dsl-resource-types.js";
import type { EntityHandle } from "./entity-handle.js";
import { isWildcardHolder, type WildcardHolder } from "./holders.js";
import type { PermissionToken, RoleToken } from "./refs.js";

export type AccessWorld = {
  readonly title: string;
  readonly relationships: readonly string[];
  readonly assertions: {
    readonly true: readonly string[];
    readonly false: readonly string[];
  };
};

export type WorldPerson = {
  readonly kind: "person";
  readonly id: string;
};

export type WorldMembers = {
  readonly kind: "members";
  readonly role: RoleToken;
  readonly resourceId: string;
};

export type WorldEntity = {
  readonly kind: "entity";
  readonly handle: EntityHandle;
  readonly id: string;
};

export type WorldSubject =
  WorldPerson | WorldMembers | WorldEntity | WildcardHolder;

export type WorldActor = WorldPerson | WorldEntity;

export type WorldExpect = {
  readonly can: (permission: PermissionToken, resourceId: string) => void;
  readonly cannot: (permission: PermissionToken, resourceId: string) => void;
};

export type WorldWrite = {
  readonly to: (subject: WorldSubject) => void;
};

export type WorldVerbs = {
  readonly user: (id: string) => WorldPerson;
  readonly entity: (target: EntityHandle | DslNode, id: string) => WorldEntity;
  readonly write: (role: RoleToken, resourceId: string) => WorldWrite;
  readonly members: (role: RoleToken, resourceId: string) => WorldMembers;
  readonly include: (other: AccessWorld) => void;
  readonly expect: (actor: WorldActor) => WorldExpect;
};

function personTuple(person: WorldPerson): string {
  return `user:${person.id}`;
}

function subjectTuple(subject: WorldSubject): string {
  if (isWildcardHolder(subject)) {
    return `${subject.entity.wireName}:*`;
  }
  if (subject.kind === "members") {
    return `${subject.role.entityWireName}:${subject.resourceId}#${subject.role.roleName}`;
  }
  if (subject.kind === "entity") {
    return `${subject.handle.wireName}:${subject.id}`;
  }
  return personTuple(subject);
}

function relationshipTuple(
  role: RoleToken,
  resourceId: string,
  subject: WorldSubject,
): string {
  return `${role.entityWireName}:${resourceId}#${role.roleName}@${subjectTuple(subject)}`;
}

function assertionTuple(
  permission: PermissionToken,
  resourceId: string,
  actor: WorldActor,
): string {
  return `${permission.entityWireName}:${resourceId}#${permission.permissionName}@${subjectTuple(actor)}`;
}

function resolveEntityHandle(target: EntityHandle | DslNode): EntityHandle {
  return "handle" in target ? target.handle : target;
}

export function world(
  title: string,
  build: (verbs: WorldVerbs) => void,
): AccessWorld {
  const relationships: string[] = [];
  const allow: string[] = [];
  const deny: string[] = [];

  const verbs: WorldVerbs = {
    user: (id) => ({ kind: "person", id }),
    entity: (target, id) => ({
      kind: "entity",
      handle: resolveEntityHandle(target),
      id,
    }),
    write: (role, resourceId) => ({
      to: (subject) => {
        relationships.push(relationshipTuple(role, resourceId, subject));
      },
    }),
    members: (role, resourceId) => ({ kind: "members", role, resourceId }),
    include: (other) => {
      relationships.push(...other.relationships);
      allow.push(...other.assertions.true);
      deny.push(...other.assertions.false);
    },
    expect: (actor) => ({
      can: (permission, resourceId) => {
        allow.push(assertionTuple(permission, resourceId, actor));
      },
      cannot: (permission, resourceId) => {
        deny.push(assertionTuple(permission, resourceId, actor));
      },
    }),
  };

  build(verbs);

  return {
    title,
    relationships,
    assertions: {
      true: allow,
      false: deny,
    },
  };
}
