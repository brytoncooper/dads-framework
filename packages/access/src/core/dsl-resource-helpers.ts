import { isDslActor, isDslLazyResource, isDslResource, parentRoleNameOf } from "./dsl-actor.js";
import type {
  AnyDslResource,
  DslExpirableUsersetHolder,
  DslPermissionTarget,
  DslRoleHolder,
  DslRoleSlot,
  DslRolesSpec,
  DslRoleToken,
  DslSingleRoleHolder,
} from "./dsl-types.js";
import type { EntityHandle } from "./entity-handle.js";
import { membersOf } from "./holders.js";
import type { SingleRoleValue } from "./holders.js";
import { isRoleToken, permissionToken } from "./refs.js";
import type { PermissionToken, RoleHolder } from "./refs.js";

function isHolderArray(holder: DslRoleHolder): holder is readonly DslSingleRoleHolder[] {
  return Array.isArray(holder);
}

export function resolveSingleRoleValue(entry: DslSingleRoleHolder): SingleRoleValue {
  if (isDslLazyResource(entry)) {
    return entry().handle;
  }
  if (isDslActor(entry) || isDslResource(entry)) {
    return entry.handle;
  }
  if (isRoleToken(entry)) {
    return membersOf(entry);
  }
  return entry;
}

export function resolveRoleHolder(holder: DslRoleHolder): RoleHolder {
  if (isHolderArray(holder)) {
    return holder.map(resolveSingleRoleValue);
  }
  return resolveSingleRoleValue(holder);
}

function createLazyRoleToken(entityWireName: string, roleName: string, getHolder: () => RoleHolder): DslRoleToken {
  const expiring: DslExpirableUsersetHolder = {
    kind: "expirable",
    holder: { kind: "userset", entityWireName, roleName },
    entityWireName,
    roleName,
  };
  return {
    kind: "role",
    entityWireName,
    roleName,
    get holder(): RoleHolder {
      return getHolder();
    },
    expiring,
  };
}

export function createPermissionBag(entityWireName: string): Readonly<Record<string, PermissionToken>> {
  const cache = new Map<string, PermissionToken>();
  const target: Record<string, PermissionToken> = {};
  return new Proxy(target, {
    get(_obj, propertyName): PermissionToken | undefined {
      if (typeof propertyName !== "string" || propertyName === "then" || propertyName === "toJSON") {
        return undefined;
      }
      const existing = cache.get(propertyName);
      if (existing !== undefined) {
        return existing;
      }
      const minted = permissionToken(entityWireName, propertyName);
      cache.set(propertyName, minted);
      return minted;
    },
  });
}

function buildAutoParentRoles(
  wireName: string,
  handle: EntityHandle,
  parentResource: AnyDslResource | undefined,
  parents: readonly AnyDslResource[],
  recursive: boolean,
): Record<string, DslRoleToken> {
  const roles: Record<string, DslRoleToken> = {};
  const parentRoleName = parentResource === undefined ? undefined : parentRoleNameOf(parentResource.wireName);

  if (parentResource !== undefined && parentRoleName !== undefined) {
    const useSelfToo = recursive && parentRoleName === "parent";
    roles[parentRoleName] = createLazyRoleToken(wireName, parentRoleName, () =>
      useSelfToo ? [parentResource.handle, handle] : parentResource.handle,
    );
  }
  if (parents.length > 0) {
    roles["parent"] = createLazyRoleToken(wireName, "parent", () => {
      const parentHandles = parents.map((entry) => entry.handle);
      return recursive ? [...parentHandles, handle] : parentHandles;
    });
  } else if (recursive && parentRoleName !== "parent") {
    roles["parent"] = createLazyRoleToken(wireName, "parent", () => handle);
  }
  return roles;
}

export function buildRoleTokens(
  wireName: string,
  handle: EntityHandle,
  declaredRoles: DslRolesSpec,
  parentResource: AnyDslResource | undefined,
  parents: readonly AnyDslResource[],
  recursive: boolean,
): Record<string, DslRoleToken> {
  const roles = buildAutoParentRoles(wireName, handle, parentResource, parents, recursive);
  for (const [roleName, holder] of Object.entries(declaredRoles)) {
    roles[roleName] = createLazyRoleToken(wireName, roleName, () => resolveRoleHolder(holder));
  }
  return roles;
}

export function createInstanceProxy(wireName: string, id: string, roleNames: ReadonlySet<string>): unknown {
  const resourceRef = { type: wireName, id };
  const base = {
    $resource: { kind: "resource-ref", type: wireName, id },
    kind: "resource-ref",
    type: wireName,
    id,
  };
  return new Proxy(base, {
    get(target, propertyName): unknown {
      if (typeof propertyName !== "string") return undefined;
      if (propertyName === "$resource") return target.$resource;
      if (roleNames.has(propertyName)) {
        const slot: DslRoleSlot = {
          kind: "dsl-role-slot",
          entityWireName: wireName,
          roleName: propertyName,
          resource: resourceRef,
        };
        return slot;
      }
      if (propertyName === "kind") return target.kind;
      if (propertyName === "type") return target.type;
      if (propertyName === "id") return target.id;
      if (propertyName === "then" || propertyName === "toJSON") {
        return undefined;
      }
      const permTarget: DslPermissionTarget = {
        kind: "dsl-permission-target",
        entityWireName: wireName,
        permissionName: propertyName,
        resource: resourceRef,
      };
      return permTarget;
    },
  });
}
