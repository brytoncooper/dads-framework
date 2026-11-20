import type { CatalogOnlyCapability } from "./catalog-only.js";
import type { EntityHandle } from "./entity-handle.js";
import type { RoleValue } from "./holders.js";
import type { LifecycleTrigger } from "./lifecycle.js";
import { permissionToken, roleToken } from "./refs.js";
import type { PermissionTerm, PermissionToken, RoleToken } from "./refs.js";
import type { ResolvedAccessDefinition } from "./access-model.js";
import { zodEnumFromNames } from "./zod-enums.js";

export type { RoleValue } from "./holders.js";

export type RoleTokens<RoleTable> = {
  readonly [RoleName in keyof RoleTable]: RoleToken;
};

export type PermissionTokens<PermissionTable> = {
  readonly [PermissionName in keyof PermissionTable]: PermissionToken;
};

export type AccessGranting<PermissionTable> = {
  readonly requires: readonly (keyof PermissionTable & string)[];
  readonly removedWhen: readonly LifecycleTrigger[];
};

export type AccessDefinition<RoleTable, PermissionTable> = {
  readonly entity: EntityHandle;
  readonly roles: RoleTokens<RoleTable>;
  readonly resolve: () => ResolvedAccessDefinition;
  readonly permissions: PermissionTokens<PermissionTable>;
  readonly zod: {
    readonly permission: ReturnType<typeof zodEnumFromNames> | undefined;
    readonly role: ReturnType<typeof zodEnumFromNames> | undefined;
  };
};

function isRoleTokenRecord<RoleTable>(
  record: Record<string, RoleToken>,
  names: readonly string[],
): record is RoleTokens<RoleTable> {
  return names.every((name) => record[name] !== undefined);
}

function mintRoleTokens<RoleTable extends Record<string, RoleValue>>(
  entity: EntityHandle,
  roles: RoleTable,
): RoleTokens<RoleTable> {
  const record: Record<string, RoleToken> = {};
  for (const [roleName, holder] of Object.entries(roles)) {
    record[roleName] = roleToken(entity.wireName, roleName, holder);
  }
  const roleNames = Object.keys(roles);
  if (!isRoleTokenRecord<RoleTable>(record, roleNames)) {
    throw new Error(`failed to mint role tokens for ${entity.wireName}`);
  }
  return record;
}

function isPermissionTermList(
  value: unknown,
): value is readonly PermissionTerm[] {
  return Array.isArray(value);
}

function expressionRecord(
  expressions: object,
): Record<string, readonly PermissionTerm[]> {
  const record: Record<string, readonly PermissionTerm[]> = {};
  for (const [permissionName, terms] of Object.entries(expressions)) {
    if (!isPermissionTermList(terms)) {
      throw new Error(`permission ${permissionName} is not a term list`);
    }
    record[permissionName] = terms;
  }
  return record;
}

function isPermissionTokenRecord<PermissionTable>(
  record: unknown,
): record is PermissionTokens<PermissionTable> {
  return typeof record === "object" && record !== null;
}

function createPermissionBag<PermissionTable>(
  entityWireName: string,
): PermissionTokens<PermissionTable> {
  const cache = new Map<string, PermissionToken>();
  const bag = new Proxy(
    {},
    {
      get(_target, propertyName): PermissionToken | undefined {
        if (typeof propertyName !== "string") {
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
    },
  );
  if (!isPermissionTokenRecord<PermissionTable>(bag)) {
    throw new Error(`failed to mint permission tokens for ${entityWireName}`);
  }
  return bag;
}

/**
 * Author one entity's roles, grant law, and permissions. Permission
 * callbacks run after every `access()` module has loaded so cross-entity
 * cycles resolve as tokens, not strings.
 */
export function access<
  const RoleTable extends Record<string, RoleValue>,
  PermissionCallback extends (
    roles: RoleTokens<RoleTable>,
  ) => Record<string, readonly PermissionTerm[]>,
>(
  entity: EntityHandle,
  spec: {
    readonly roles: RoleTable;
    readonly granting?: {
      readonly requires: readonly (keyof ReturnType<PermissionCallback> &
        string)[];
      readonly removedWhen: readonly LifecycleTrigger[];
    };
    readonly catalogOnly?: readonly CatalogOnlyCapability[];
    readonly permissions: PermissionCallback;
  },
): AccessDefinition<RoleTable, ReturnType<PermissionCallback>> {
  const roles = mintRoleTokens(entity, spec.roles);
  const permissions = createPermissionBag<ReturnType<PermissionCallback>>(
    entity.wireName,
  );

  let resolved: ResolvedAccessDefinition | undefined;
  function resolve(): ResolvedAccessDefinition {
    if (resolved !== undefined) return resolved;
    const expressions = expressionRecord(spec.permissions(roles));
    const granting =
      spec.granting === undefined
        ? undefined
        : {
            requires: spec.granting.requires.map((permissionName) =>
              permissionToken(entity.wireName, permissionName),
            ),
            removedWhen: spec.granting.removedWhen,
          };
    resolved = {
      entity,
      roles,
      permissions,
      expressions,
      granting,
      catalogOnly: spec.catalogOnly ?? [],
    };
    return resolved;
  }

  return {
    entity,
    roles,
    permissions,
    resolve,
    get zod() {
      const permissionNames = Object.keys(resolve().expressions);
      const roleNames = Object.keys(roles);
      return {
        permission:
          permissionNames.length === 0
            ? undefined
            : zodEnumFromNames(permissionNames),
        role: roleNames.length === 0 ? undefined : zodEnumFromNames(roleNames),
      };
    },
  };
}
