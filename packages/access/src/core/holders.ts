import type { EntityHandle } from "./entity-handle.js";
import { isGrantableRole } from "./grantable.js";
import type { GrantableRole } from "./grantable.js";
import type { RoleToken } from "./refs.js";

export type WildcardHolder = {
  readonly kind: "wildcard";
  readonly entity: EntityHandle;
};

export type UsersetHolder = {
  readonly kind: "userset";
  readonly entityWireName: string;
  readonly roleName: string;
};

export type ExpirableHolder = {
  readonly kind: "expirable";
  readonly holder: SingleRoleValue;
};

/**
 * Every subject of this type (`user:*`). Used for tenancy gates.
 */
export function wildcard(entity: EntityHandle): WildcardHolder {
  return { kind: "wildcard", entity };
}

/**
 * Subjects that hold `role` on another object (`work_assignment#assignee`).
 */
export function membersOf(role: RoleToken): UsersetHolder {
  return {
    kind: "userset",
    entityWireName: role.entityWireName,
    roleName: role.roleName,
  };
}

/**
 * Marks a subject type as supporting SpiceDB relationship expiration
 * (`user with expiration`).
 */
export function withExpiration(holder: SingleRoleValue): ExpirableHolder {
  return isExpirableHolder(holder) ? holder : { kind: "expirable", holder };
}

export function isWildcardHolder(value: unknown): value is WildcardHolder {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "wildcard";
}

export function isUsersetHolder(value: unknown): value is UsersetHolder {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "userset";
}

export function isExpirableHolder(value: unknown): value is ExpirableHolder {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "expirable";
}

export function isEntityHandleHolder(value: unknown): value is EntityHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    "wireName" in value &&
    !isGrantableRole(value) &&
    !isWildcardHolder(value) &&
    !isUsersetHolder(value) &&
    !isExpirableHolder(value)
  );
}

export type SingleRoleValue = EntityHandle | GrantableRole | WildcardHolder | UsersetHolder | ExpirableHolder;

export type RoleValue = SingleRoleValue | readonly SingleRoleValue[];
