import type { AnyDslRoleSlot, DslActor, DslPermissionTarget, DslRoleSlot, DslSubjectInput } from "../core/dsl-types.js";
import type { EntityHandle } from "../core/entity-handle.js";
import type { PermissionToken } from "../core/refs.js";
import {
  relationshipWrite,
  type Authorization,
  type DirectSubjectLookup,
  type PermissionQuery,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectLookup,
  type SubjectLookupResult,
  type SubjectRef,
} from "./authorization.js";

export type AccessClientAddOptions = {
  readonly expiresAt?: Date;
};

export type AccessClientCheckOptions = {
  readonly consistencyToken?: SpiceDbConsistencyToken;
  readonly consistency?: "fully-consistent";
};

export type AccessClientLookupOptions = {
  readonly consistencyToken?: SpiceDbConsistencyToken;
};

export type AccessClientDirectOptions = {
  readonly consistency?: "fully-consistent";
  readonly consistencyToken?: SpiceDbConsistencyToken;
};

export type AccessClient = {
  readonly add: <AllowedSubject extends DslSubjectInput>(
    subject: NoInfer<AllowedSubject>,
    slot: DslRoleSlot<string, string, AllowedSubject>,
    options?: AccessClientAddOptions,
  ) => Promise<SpiceDbConsistencyToken>;
  readonly remove: <AllowedSubject extends DslSubjectInput>(
    subject: NoInfer<AllowedSubject>,
    slot: DslRoleSlot<string, string, AllowedSubject>,
  ) => Promise<SpiceDbConsistencyToken>;
  readonly can: (
    subject: DslSubjectInput,
    target: DslPermissionTarget,
    options?: AccessClientCheckOptions,
  ) => Promise<boolean>;
  readonly list: (
    subject: DslSubjectInput,
    permission: PermissionToken,
    options?: AccessClientLookupOptions,
  ) => Promise<readonly string[]>;
  readonly whoCan: (
    target: DslPermissionTarget,
    actorHandle: DslActor | EntityHandle,
    options?: AccessClientLookupOptions,
  ) => Promise<SubjectLookupResult>;
  readonly listDirect: (slot: AnyDslRoleSlot, options?: AccessClientDirectOptions) => Promise<readonly SubjectRef[]>;
};

function toSubjectRef(subject: DslSubjectInput): SubjectRef {
  if ("$resource" in subject) {
    return {
      type: subject.$resource.type,
      id: subject.$resource.id,
    };
  }
  if (subject.kind === "actor-ref") {
    return { type: subject.type, id: subject.id };
  }
  if (subject.kind === "wildcard") {
    return { type: subject.entity.wireName, id: "*" };
  }
  return {
    type: subject.resource.type,
    id: subject.resource.id,
    relation: subject.roleName,
  };
}

function buildPermissionQuery(
  subject: DslSubjectInput,
  target: DslPermissionTarget,
  options?: AccessClientCheckOptions,
): PermissionQuery {
  return {
    subject: toSubjectRef(subject),
    permission: target.permissionName,
    resource: target.resource,
    ...(options?.consistencyToken !== undefined ? { consistencyToken: options.consistencyToken } : {}),
    ...(options?.consistency !== undefined ? { consistency: options.consistency } : {}),
  };
}

function buildResourceLookup(
  subject: DslSubjectInput,
  permission: PermissionToken,
  options?: AccessClientLookupOptions,
): ResourceLookup {
  return {
    subject: toSubjectRef(subject),
    permission: permission.permissionName,
    resourceType: permission.entityWireName,
    ...(options?.consistencyToken !== undefined ? { consistencyToken: options.consistencyToken } : {}),
  };
}

function buildSubjectLookup(
  target: DslPermissionTarget,
  actorHandle: DslActor | EntityHandle,
  options?: AccessClientLookupOptions,
): SubjectLookup {
  return {
    resource: target.resource,
    permission: target.permissionName,
    subjectType: actorHandle.wireName,
    ...(options?.consistencyToken !== undefined ? { consistencyToken: options.consistencyToken } : {}),
  };
}

function buildDirectLookup(slot: AnyDslRoleSlot, options?: AccessClientDirectOptions): DirectSubjectLookup {
  return {
    resource: slot.resource,
    relation: slot.roleName,
    ...(options?.consistency !== undefined ? { consistency: options.consistency } : {}),
    ...(options?.consistencyToken !== undefined ? { consistencyToken: options.consistencyToken } : {}),
  };
}

/**
 * Symmetric typed runtime client over any `Authorization` backend.
 * Enforces allowed subject types for every `add` / `remove` slot at compile time.
 */
export function createAccessClient(authorization: Authorization): AccessClient {
  return {
    add(subject, slot, options) {
      const write = relationshipWrite(slot.resource, slot.roleName, toSubjectRef(subject), options);
      return authorization.writeRelationships([write]);
    },
    remove(subject, slot) {
      return authorization.deleteRelationships({
        resourceType: slot.resource.type,
        resourceId: slot.resource.id,
        relation: slot.roleName,
        subject: toSubjectRef(subject),
      });
    },
    can: (subject, target, options) => authorization.check(buildPermissionQuery(subject, target, options)),
    list(subject, permission, options) {
      return authorization.lookupResources(buildResourceLookup(subject, permission, options));
    },
    whoCan(target, actorHandle, options) {
      if (authorization.lookupSubjects === undefined) {
        return Promise.reject(new Error("underlying Authorization does not implement lookupSubjects"));
      }
      return authorization.lookupSubjects(buildSubjectLookup(target, actorHandle, options));
    },
    listDirect(slot, options) {
      return authorization.listDirectSubjects(buildDirectLookup(slot, options));
    },
  };
}
