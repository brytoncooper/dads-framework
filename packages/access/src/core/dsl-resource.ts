import { z } from "zod";

import type { CatalogOnlyCapability } from "./catalog-only.js";
import { parentRoleNameOf } from "./dsl-actor.js";
import {
  buildRoleTokens,
  createInstanceProxy,
  createPermissionBag,
} from "./dsl-resource-helpers.js";
import type {
  AnyDslChildSpec,
  ContextualInlineChildSpec,
  DslCanContext,
  DslChildSpec,
  DslInheritOption,
  EffectiveRoleSubjects,
  InlineChildPermissionExpr,
  ResolvedInheritedPerms,
  ValidatedResourceResult,
} from "./dsl-resource-types.js";
import type {
  AnyDslResource,
  DslGrantingSpec,
  DslPermissionExpr,
  DslRolesSpec,
  DslSubjectInput,
} from "./dsl-types.js";
import { entityHandle } from "./entity-handle.js";
import type { EntityHandle } from "./entity-handle.js";
import type { RoleToken } from "./refs.js";

const defaultIdSchema: z.ZodType<string> = z.string().min(1);

const RESERVED_RESOURCE_PROPS = new Set([
  "kind",
  "wireName",
  "idSchema",
  "handle",
  "entity",
  "roles",
  "can",
  "permissions",
  "child",
]);

export type DslResourceRecord = {
  readonly resource: AnyDslResource;
  readonly wireName: string;
  readonly handle: EntityHandle;
  readonly declaredRoles: DslRolesSpec;
  readonly parentResource: AnyDslResource | undefined;
  readonly parentRoleName: string | undefined;
  readonly inherit: "all" | "none" | readonly string[];
  readonly parents: readonly AnyDslResource[];
  readonly recursive: boolean;
  readonly canFn:
    | ((
        context: Readonly<Record<string, unknown>>,
      ) => Record<string, InlineChildPermissionExpr>)
    | undefined;
  readonly granting: DslGrantingSpec | undefined;
  readonly catalogOnly: readonly CatalogOnlyCapability[];
  readonly childNodes: AnyDslResource[];
};

const resourceRecords = new WeakMap<object, DslResourceRecord>();
const roleTokenOwners = new WeakMap<RoleToken, AnyDslResource>();
const expirableUsersetOwners = new WeakMap<object, AnyDslResource>();

export function getDslResourceRecord(
  node: AnyDslResource,
): DslResourceRecord | undefined {
  return resourceRecords.get(node);
}

export function getRoleTokenOwner(
  token: RoleToken,
): AnyDslResource | undefined {
  return roleTokenOwners.get(token);
}

export function getExpirableUsersetOwner(
  holder: object,
): AnyDslResource | undefined {
  return expirableUsersetOwners.get(holder);
}

type InternalResourceInit = {
  readonly wireName: string;
  readonly idSchema: z.ZodType<string>;
  readonly declaredRoles: DslRolesSpec;
  readonly parentResource: AnyDslResource | undefined;
  readonly inherit: "all" | "none" | readonly string[];
  readonly parents: readonly AnyDslResource[];
  readonly recursive: boolean;
  readonly canFn:
    | ((
        context: Readonly<Record<string, unknown>>,
      ) => Record<string, InlineChildPermissionExpr>)
    | undefined;
  readonly granting: DslGrantingSpec | undefined;
  readonly catalogOnly: readonly CatalogOnlyCapability[];
  readonly inlineChildren:
    Readonly<Record<string, AnyDslChildSpec>> | undefined;
};

function isAnyDslResource(value: unknown): value is AnyDslResource {
  return typeof value === "function" && "kind" in value;
}

function isValidatedResource<
  WireName extends string,
  RoleSubjects extends Record<string, DslSubjectInput>,
  Perms extends string,
  Children,
>(
  value: AnyDslResource,
  wireName: WireName,
): value is ValidatedResourceResult<WireName, RoleSubjects, Perms, Children> &
  AnyDslResource {
  return value.wireName === wireName;
}

function isCanFn(
  value: unknown,
): value is (
  context: Readonly<Record<string, unknown>>,
) => Record<string, InlineChildPermissionExpr> {
  return typeof value === "function";
}

function attachInlineChildren(
  parentNode: AnyDslResource,
  record: DslResourceRecord,
  inlineChildren: Readonly<Record<string, AnyDslChildSpec>>,
): void {
  for (const [childWireName, childSpec] of Object.entries(inlineChildren)) {
    if (RESERVED_RESOURCE_PROPS.has(childWireName)) {
      throw new Error(
        `child name "${childWireName}" conflicts with reserved resource property`,
      );
    }
    const childNode = createChildNode(
      parentNode,
      record,
      childWireName,
      childSpec,
    );
    Object.defineProperty(parentNode, childWireName, {
      value: childNode,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
}

function createChildNode(
  parentNode: AnyDslResource,
  parentRecord: DslResourceRecord,
  childWireName: string,
  childSpec: AnyDslChildSpec,
): AnyDslResource {
  const childNode = createInternalResource({
    wireName: childWireName,
    idSchema: childSpec.id ?? defaultIdSchema,
    declaredRoles: childSpec.roles ?? {},
    parentResource: parentNode,
    inherit: childSpec.inherit,
    parents: [],
    recursive: childSpec.recursive === true,
    canFn: isCanFn(childSpec.can) ? childSpec.can : undefined,
    granting: childSpec.granting,
    catalogOnly: childSpec.catalogOnly ?? [],
    inlineChildren: childSpec.children,
  });
  parentRecord.childNodes.push(childNode);
  return childNode;
}

function createInternalResource(init: InternalResourceInit): AnyDslResource {
  const handle = entityHandle({
    wireName: init.wireName,
    idSchema: init.idSchema,
  });

  const roles = buildRoleTokens(
    init.wireName,
    handle,
    init.declaredRoles,
    init.parentResource,
    init.parents,
    init.recursive,
  );
  const roleNames = new Set(Object.keys(roles));
  const permissions = createPermissionBag(init.wireName);

  function callResource(id: string): unknown {
    return createInstanceProxy(init.wireName, id, roleNames);
  }

  const childNodes: AnyDslResource[] = [];
  const parentRoleName =
    init.parentResource === undefined
      ? undefined
      : parentRoleNameOf(init.parentResource.wireName);

  const nodeBase = Object.assign(callResource, {
    kind: "dsl-resource",
    wireName: init.wireName,
    idSchema: init.idSchema,
    handle,
    entity: handle,
    roles,
    can: permissions,
    permissions,
    child: (
      childWireName: string,
      childSpec: AnyDslChildSpec,
    ): AnyDslResource =>
      createChildNode(node, record, childWireName, childSpec),
  });

  if (!isAnyDslResource(nodeBase)) {
    throw new Error(`failed to construct resource ${init.wireName}`);
  }
  const node = nodeBase;

  const record: DslResourceRecord = {
    resource: node,
    wireName: init.wireName,
    handle,
    declaredRoles: init.declaredRoles,
    parentResource: init.parentResource,
    parentRoleName,
    inherit: init.inherit,
    parents: init.parents,
    recursive: init.recursive,
    canFn: init.canFn,
    granting: init.granting,
    catalogOnly: init.catalogOnly,
    childNodes,
  };
  resourceRecords.set(node, record);
  for (const token of Object.values(roles)) {
    roleTokenOwners.set(token, node);
    expirableUsersetOwners.set(token.expiring, node);
  }

  if (init.inlineChildren !== undefined) {
    attachInlineChildren(node, record, init.inlineChildren);
  }

  return node;
}

/**
 * Declare an authorization resource with roles, permission expressions,
 * optional multi-parent DAG links, recursion, nested children, and
 * optional catalog/granting metadata.
 */
export function resource<
  const WireName extends string,
  const RolesSpec extends DslRolesSpec = Record<never, never>,
  const Parents extends readonly AnyDslResource[] = readonly [],
  const CanResult extends Record<string, DslPermissionExpr> = Record<
    never,
    never
  >,
  const Recursive extends boolean = false,
  const Children extends Readonly<Record<string, AnyDslChildSpec>> = Record<
    never,
    never
  >,
>(
  wireName: WireName,
  spec: {
    readonly id?: z.ZodType<string>;
    readonly roles?: RolesSpec;
    readonly parents?: Parents;
    readonly recursive?: Recursive;
    readonly can?: (
      context: DslCanContext<
        RolesSpec,
        never,
        never,
        Parents,
        WireName,
        Recursive
      >,
    ) => CanResult;
    readonly granting?: DslGrantingSpec<keyof CanResult & string>;
    readonly catalogOnly?: readonly CatalogOnlyCapability[];
    readonly children?: Children &
      Readonly<
        Record<
          string,
          ContextualInlineChildSpec<NoInfer<keyof CanResult & string>>
        >
      >;
  },
): ValidatedResourceResult<
  WireName,
  EffectiveRoleSubjects<WireName, RolesSpec, never, Parents, Recursive>,
  keyof CanResult & string,
  Children
> {
  const created = createInternalResource({
    wireName,
    idSchema: spec.id ?? defaultIdSchema,
    declaredRoles: spec.roles ?? {},
    parentResource: undefined,
    inherit: "none",
    parents: spec.parents ?? [],
    recursive: spec.recursive === true,
    canFn: isCanFn(spec.can) ? spec.can : undefined,
    granting: spec.granting,
    catalogOnly: spec.catalogOnly ?? [],
    inlineChildren: spec.children,
  });

  if (
    !isValidatedResource<
      WireName,
      EffectiveRoleSubjects<WireName, RolesSpec, never, Parents, Recursive>,
      keyof CanResult & string,
      Children
    >(created, wireName)
  ) {
    throw new Error(`failed to construct resource ${wireName}`);
  }
  return created;
}

export type { DslChildSpec, DslInheritOption, ResolvedInheritedPerms };
