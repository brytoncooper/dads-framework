import type { z } from "zod";

import type { EntityHandle } from "./entity-handle.js";
import type { SingleRoleValue, UsersetHolder, WildcardHolder } from "./holders.js";
import type { LifecycleTrigger } from "./lifecycle.js";
import type { PermissionTerm, PermissionToken, RoleToken } from "./refs.js";

/** Extracts the final path segment for an auto-generated parent relation name. */
export type ParentRoleName<WireName extends string> = WireName extends `${string}/${infer Leaf}`
  ? ParentRoleName<Leaf>
  : WireName;

export type ActorRef<WireName extends string = string> = {
  readonly kind: "actor-ref";
  readonly type: WireName;
  readonly id: string;
};

export type DslExpirableWildcardHolder<WireName extends string = string> = {
  readonly kind: "expirable";
  readonly holder: WildcardHolder;
  readonly wireName: WireName;
};

export type DslWildcardActorHolder<WireName extends string = string> = {
  readonly kind: "wildcard";
  readonly entity: EntityHandle<WireName>;
  readonly wireName: WireName;
  readonly expiring: DslExpirableWildcardHolder<WireName>;
};

export type DslExpirableActorHolder<WireName extends string = string> = {
  readonly kind: "expirable";
  readonly holder: EntityHandle<WireName>;
  readonly actorWireName: WireName;
};

export type DslExpirableUsersetHolder<WireName extends string = string, RoleName extends string = string> = {
  readonly kind: "expirable";
  readonly holder: UsersetHolder;
  readonly entityWireName: WireName;
  readonly roleName: RoleName;
};

export type DslActorOptions = {
  readonly id?: z.ZodType<string>;
};

export type DslActor<WireName extends string = string> = ((id: string) => ActorRef<WireName>) & {
  readonly kind: "dsl-actor";
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
  readonly handle: EntityHandle<WireName>;
  readonly entity: EntityHandle;
  readonly expiring: DslExpirableActorHolder<WireName>;
  readonly anyone: DslWildcardActorHolder<WireName>;
};

export type ResourceSubjectRef<WireName extends string = string, Id extends string = string> = {
  readonly $resource: {
    readonly kind: "resource-ref";
    readonly type: WireName;
    readonly id: Id;
  };
};

export type DslUsersetSubject<
  WireName extends string = string,
  RoleName extends string = string,
  Id extends string = string,
> = {
  readonly kind: "dsl-role-slot";
  readonly entityWireName: WireName;
  readonly roleName: RoleName;
  readonly resource: { readonly type: WireName; readonly id: Id };
};

export type DslSubjectInput = ActorRef | DslWildcardActorHolder | ResourceSubjectRef | DslUsersetSubject;

export type AnyDslRoleSlot = {
  readonly kind: "dsl-role-slot";
  readonly entityWireName: string;
  readonly roleName: string;
  readonly resource: { readonly type: string; readonly id: string };
};

export type DslRoleSlot<
  EntityWire extends string = string,
  RoleName extends string = string,
  AllowedSubject extends DslSubjectInput = DslSubjectInput,
  Id extends string = string,
> = {
  readonly kind: "dsl-role-slot";
  readonly entityWireName: EntityWire;
  readonly roleName: RoleName;
  readonly resource: { readonly type: EntityWire; readonly id: Id };
  readonly __allowedSubject?: AllowedSubject;
};

export type DslPermissionTarget<
  EntityWire extends string = string,
  PermName extends string = string,
  Id extends string = string,
> = {
  readonly kind: "dsl-permission-target";
  readonly entityWireName: EntityWire;
  readonly permissionName: PermName;
  readonly resource: { readonly type: EntityWire; readonly id: Id };
};

export type DslRoleToken<
  WireName extends string = string,
  RoleName extends string = string,
  AllowedSubject extends DslSubjectInput = DslSubjectInput,
> = RoleToken & {
  readonly entityWireName: WireName;
  readonly roleName: RoleName;
  readonly expiring: DslExpirableUsersetHolder<WireName, RoleName>;
  readonly __allowedSubject?: AllowedSubject;
};

export type DslPermissionToken<WireName extends string = string, PermName extends string = string> = PermissionToken & {
  readonly entityWireName: WireName;
  readonly permissionName: PermName;
};

export type DslGrantingSpec<PermName extends string = string> = {
  readonly requires: readonly PermName[];
  readonly removedWhen: readonly LifecycleTrigger[];
};

export type DslTermInput = DslTerm | PermissionTerm | readonly DslTermInput[];

export type DslTerm = {
  readonly kind: "dsl-term";
  readonly term: PermissionTerm;
  readonly or: (...others: readonly DslTermInput[]) => DslTerm;
  readonly and: (...others: readonly DslTermInput[]) => DslTerm;
  readonly unless: (blocked: DslTermInput) => DslTerm;
};

export type DslPermissionExpr = DslTermInput;

export type DslRoleRef<TargetPerms extends string = never> = DslTerm & {
  readonly $roleToken: RoleToken;
  readonly $targetPerms?: TargetPerms;
} & {
  readonly [K in TargetPerms]: DslTerm;
};

export type DslEveryProxy<TargetPerms extends string> = {
  readonly [K in TargetPerms]: DslTerm;
};

export type AnyDslResource = {
  readonly kind: "dsl-resource";
  readonly wireName: string;
  readonly idSchema: z.ZodType<string>;
  readonly handle: EntityHandle;
  readonly entity: EntityHandle;
  readonly roles: Readonly<Record<string, RoleToken>>;
  readonly can: Readonly<Record<string, PermissionToken>>;
  readonly permissions: Readonly<Record<string, PermissionToken>>;
};

export type DslLazyResource = () => AnyDslResource;

export type DslSingleRoleHolder =
  | DslActor
  | DslExpirableActorHolder
  | DslWildcardActorHolder
  | DslExpirableWildcardHolder
  | DslExpirableUsersetHolder
  | AnyDslResource
  | RoleToken
  | DslLazyResource
  | SingleRoleValue;

export type DslRoleHolder = DslSingleRoleHolder | readonly DslSingleRoleHolder[];

export type DslRolesSpec = Readonly<Record<string, DslRoleHolder>>;

export type ResourceWireNameOf<R> = R extends {
  readonly kind: "dsl-resource";
  readonly wireName: infer W extends string;
}
  ? W
  : never;

export type ResourceIdOf<R> = R extends {
  readonly kind: "dsl-resource";
  readonly idSchema: infer IdSchema extends z.ZodType<string>;
}
  ? z.output<IdSchema> & string
  : string;

export type ResourcePermsOf<R> = R extends {
  readonly kind: "dsl-resource";
  readonly can: infer C;
}
  ? keyof C & string
  : never;

export type ResourceRolesOf<R> = R extends {
  readonly kind: "dsl-resource";
  readonly roles: infer Roles;
}
  ? keyof Roles & string
  : never;

export type TargetPermsOfSingleHolder<H> = H extends () => infer Target
  ? ResourcePermsOf<Target> | ResourceRolesOf<Target>
  : ResourcePermsOf<H> | ResourceRolesOf<H>;

export type IntersectHolderPerms<List extends readonly unknown[]> = List extends readonly []
  ? never
  : List extends readonly [infer Head, ...infer Tail]
    ? Tail extends readonly []
      ? TargetPermsOfSingleHolder<Head>
      : TargetPermsOfSingleHolder<Head> & IntersectHolderPerms<Tail>
    : never;

export type TargetPermsOfHolder<H> = H extends readonly unknown[]
  ? IntersectHolderPerms<H>
  : TargetPermsOfSingleHolder<H>;

export type AllowedSubjectForSingleHolder<H> =
  H extends DslActor<infer W>
    ? ActorRef<W>
    : H extends DslExpirableActorHolder<infer W>
      ? ActorRef<W>
      : H extends DslWildcardActorHolder<infer W>
        ? DslWildcardActorHolder<W>
        : H extends DslExpirableWildcardHolder<infer W>
          ? DslWildcardActorHolder<W>
          : H extends DslExpirableUsersetHolder<infer W, infer R>
            ? DslUsersetSubject<W, R>
            : H extends {
                  readonly kind: "role";
                  readonly entityWireName: infer W extends string;
                  readonly roleName: infer R extends string;
                }
              ? DslUsersetSubject<W, R>
              : H extends {
                    readonly kind: "dsl-resource";
                    readonly wireName: infer W extends string;
                  }
                ? ResourceSubjectRef<W, ResourceIdOf<H>>
                : H extends () => infer Target
                  ? AllowedSubjectForSingleHolder<Target>
                  : H extends EntityHandle<infer W, infer Id>
                    ? ActorRef<W> | ResourceSubjectRef<W, Id>
                    : DslSubjectInput;

export type AllowedSubjectForHolder<H> = H extends readonly (infer Item)[]
  ? AllowedSubjectForSingleHolder<Item>
  : AllowedSubjectForSingleHolder<H>;

export type SubjectMapFromRoles<RolesSpec extends DslRolesSpec> = {
  readonly [K in keyof RolesSpec & string]: AllowedSubjectForHolder<RolesSpec[K]>;
};

export type SharedParentPermissions<Parents extends readonly AnyDslResource[]> = IntersectHolderPerms<Parents>;

export type ParentsSubjectUnion<Parents extends readonly AnyDslResource[]> = Parents extends readonly []
  ? never
  : Parents[number] extends infer P
    ? P extends AnyDslResource
      ? ResourceSubjectRef<ResourceWireNameOf<P>, ResourceIdOf<P>>
      : never
    : never;
