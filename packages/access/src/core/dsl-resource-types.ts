import type { z } from "zod";

import type { AccessMigrationMeta } from "./access-model.js";
import type {
  AnyDslResource,
  DslActor,
  DslPermissionExpr,
  DslPermissionTarget,
  DslPermissionToken,
  DslRoleRef,
  DslRoleSlot,
  DslRolesSpec,
  DslRoleToken,
  DslSubjectInput,
  ParentRoleName,
  ParentsSubjectUnion,
  ResourceSubjectRef,
  SharedParentPermissions,
  SubjectMapFromRoles,
  TargetPermsOfHolder,
} from "./dsl-types.js";
import type { EntityHandle, EntityKind } from "./entity-handle.js";
import type { ScopeBindings } from "./scope-bindings.js";
import type { VisibleRecordException } from "./visible-record-exceptions.js";

export type DslInheritOption<ParentPerms extends string> =
  "all" | "none" | readonly ParentPerms[];

export type ResolvedInheritedPerms<
  ParentPerms extends string,
  Inherit,
> = Inherit extends "all"
  ? ParentPerms
  : Inherit extends "none"
    ? never
    : Inherit extends readonly (infer K extends string)[]
      ? K & ParentPerms
      : never;

export type DslCanContext<
  RolesSpec extends DslRolesSpec,
  ParentWire extends string = never,
  ParentPerms extends string = never,
  Parents extends readonly AnyDslResource[] = readonly [],
  SelfWire extends string = never,
  Recursive extends boolean = false,
> = {
  readonly [K in keyof RolesSpec & string]: DslRoleRef<
    TargetPermsOfHolder<RolesSpec[K]>
  >;
} & ([ParentWire] extends [never]
  ? unknown
  : {
      readonly parent: DslRoleRef<ParentPerms>;
    } & {
      readonly [K in ParentRoleName<ParentWire>]: DslRoleRef<ParentPerms>;
    }) &
  (Parents extends readonly []
    ? unknown
    : {
        readonly parents: DslRoleRef<SharedParentPermissions<Parents>>;
      }) &
  (Recursive extends true
    ? [ParentWire] extends [never]
      ? { readonly parent: DslRoleRef }
      : { readonly selfParent?: DslRoleRef }
    : unknown) &
  ([SelfWire] extends [never] ? unknown : unknown);

export type EffectiveRoleSubjects<
  WireName extends string,
  RolesSpec extends DslRolesSpec,
  ParentWire extends string = never,
  Parents extends readonly AnyDslResource[] = readonly [],
  Recursive extends boolean = false,
> = SubjectMapFromRoles<RolesSpec> &
  ([ParentWire] extends [never]
    ? unknown
    : {
        readonly [
          K in ParentRoleName<ParentWire>
        ]: ResourceSubjectRef<ParentWire>;
      }) &
  (Parents extends readonly []
    ? unknown
    : {
        readonly parent: Recursive extends true
          ? ParentsSubjectUnion<Parents> | ResourceSubjectRef<WireName>
          : ParentsSubjectUnion<Parents>;
      }) &
  (Recursive extends true
    ? Parents extends readonly []
      ? { readonly parent: ResourceSubjectRef<WireName> }
      : unknown
    : unknown);

export type DslResourceInstance<
  WireName extends string,
  RoleSubjects extends Record<string, DslSubjectInput>,
  Perms extends string,
> = ResourceSubjectRef<WireName> &
  Omit<
    {
      readonly kind: "resource-ref";
      readonly type: WireName;
      readonly id: string;
    },
    (keyof RoleSubjects & string) | Perms
  > & {
    readonly [R in keyof RoleSubjects & string]: DslRoleSlot<
      WireName,
      R,
      RoleSubjects[R]
    >;
  } & {
    readonly [
      P in Exclude<Perms, keyof RoleSubjects & string>
    ]: DslPermissionTarget<WireName, P>;
  };

export type InlineChildPermissionExpr =
  DslPermissionExpr | undefined | readonly (DslPermissionExpr | undefined)[];

export type AnyDslChildSpec = {
  readonly id?: z.ZodType<string>;
  readonly kind?: EntityKind;
  readonly inherit: "all" | "none" | readonly string[];
  readonly recursive?: boolean;
  readonly roles?: DslRolesSpec;
  readonly can?: (context: never) => Record<string, InlineChildPermissionExpr>;
  readonly children?: Readonly<Record<string, AnyDslChildSpec>>;
};

export type ContextualInlineChildSpec<ParentPerms extends string> = {
  readonly id?: z.ZodType<string>;
  readonly kind?: EntityKind;
  readonly inherit: "all" | "none" | readonly string[];
  readonly recursive?: boolean;
  readonly roles?: DslRolesSpec;
  readonly can?: (
    context: Readonly<Record<string, DslRoleRef>> & {
      readonly parent: DslRoleRef<ParentPerms>;
    },
  ) => Record<string, InlineChildPermissionExpr>;
  readonly children?: Readonly<
    Record<string, ContextualInlineChildSpec<string>>
  >;
};

export type DslChildSpec<
  ParentWire extends string,
  ParentPerms extends string,
  ChildWire extends string,
  Inherit extends DslInheritOption<ParentPerms>,
  RolesSpec extends DslRolesSpec,
  CanResult extends Record<string, DslPermissionExpr>,
  Recursive extends boolean,
  Children extends Readonly<Record<string, AnyDslChildSpec>>,
> = {
  readonly id?: z.ZodType<string>;
  readonly kind?: EntityKind;
  readonly inherit: Inherit;
  readonly recursive?: Recursive;
  readonly roles?: RolesSpec;
  readonly can?: (
    context: DslCanContext<
      RolesSpec,
      ParentWire,
      ParentPerms,
      readonly [],
      ChildWire,
      Recursive
    >,
  ) => CanResult;
  readonly children?: Children &
    Readonly<
      Record<
        string,
        ContextualInlineChildSpec<
          | ResolvedInheritedPerms<ParentPerms, NoInfer<Inherit>>
          | (keyof NoInfer<CanResult> & string)
        >
      >
    >;
};

type ExtractRolesFromSpec<Spec> = Spec extends {
  readonly roles: infer R extends DslRolesSpec;
}
  ? R
  : Record<never, never>;

type ExtractRecursiveFromSpec<Spec> = Spec extends {
  readonly recursive: true;
}
  ? true
  : false;

type ExtractCanKeysFromSpec<Spec> = Spec extends {
  readonly can: (context: never) => infer R;
}
  ? keyof R & string
  : never;

type ExtractInheritFromSpec<Spec> = Spec extends { readonly inherit: infer I }
  ? I
  : "none";

type ExtractChildrenFromSpec<Spec> = Spec extends {
  readonly children: infer C extends Readonly<Record<string, AnyDslChildSpec>>;
}
  ? C
  : Record<never, never>;

export type InvalidInheritKeys<
  ParentPerms extends string,
  Inherit,
> = Inherit extends "all" | "none"
  ? never
  : Inherit extends readonly (infer K extends string)[]
    ? Exclude<K, ParentPerms>
    : never;

export type InvalidInlineChildrenError<ParentPerms extends string, Children> = [
  keyof Children & string,
] extends [never]
  ? never
  : {
      readonly [ChildWire in keyof Children & string]:
        | InvalidInheritKeys<
            ParentPerms,
            ExtractInheritFromSpec<Children[ChildWire]>
          >
        | ([
            keyof ExtractChildrenFromSpec<Children[ChildWire]> & string,
          ] extends [never]
            ? never
            : InvalidInlineChildrenError<
                | ResolvedInheritedPerms<
                    ParentPerms,
                    ExtractInheritFromSpec<Children[ChildWire]>
                  >
                | ExtractCanKeysFromSpec<Children[ChildWire]>,
                ExtractChildrenFromSpec<Children[ChildWire]>
              >);
    }[keyof Children & string];

export type MaterializeChildResource<
  ParentWire extends string,
  ParentPerms extends string,
  ChildWire extends string,
  Spec,
> = DslResource<
  ChildWire,
  EffectiveRoleSubjects<
    ChildWire,
    ExtractRolesFromSpec<Spec>,
    ParentWire,
    readonly [],
    ExtractRecursiveFromSpec<Spec>
  >,
  | ResolvedInheritedPerms<ParentPerms, ExtractInheritFromSpec<Spec>>
  | ExtractCanKeysFromSpec<Spec>,
  MaterializeChildrenMap<
    ChildWire,
    | ResolvedInheritedPerms<ParentPerms, ExtractInheritFromSpec<Spec>>
    | ExtractCanKeysFromSpec<Spec>,
    ExtractChildrenFromSpec<Spec>
  >
>;

export type MaterializeChildrenMap<
  ParentWire extends string,
  ParentPerms extends string,
  Children,
> = [keyof Children & string] extends [never]
  ? Record<never, never>
  : {
      readonly [ChildWire in keyof Children & string]: MaterializeChildResource<
        ParentWire,
        ParentPerms,
        ChildWire,
        Children[ChildWire]
      >;
    };

export type ValidatedResourceResult<
  WireName extends string,
  RoleSubjects extends Record<string, DslSubjectInput>,
  Perms extends string,
  Children,
> = [InvalidInlineChildrenError<Perms, Children>] extends [never]
  ? DslResource<
      WireName,
      RoleSubjects,
      Perms,
      MaterializeChildrenMap<WireName, Perms, Children>
    >
  : {
      readonly __dslInvalidInheritPermission: InvalidInlineChildrenError<
        Perms,
        Children
      >;
    };

export type DslResource<
  WireName extends string,
  RoleSubjects extends Record<string, DslSubjectInput>,
  Perms extends string,
  ChildrenMap extends Record<string, AnyDslResource> = Record<never, never>,
> = ((id: string) => DslResourceInstance<WireName, RoleSubjects, Perms>) & {
  readonly kind: "dsl-resource";
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
  readonly handle: EntityHandle<WireName>;
  readonly roles: {
    readonly [R in keyof RoleSubjects & string]: DslRoleToken<
      WireName,
      R,
      RoleSubjects[R]
    >;
  };
  readonly can: {
    readonly [P in Perms]: DslPermissionToken<WireName, P>;
  };
  readonly permissions: {
    readonly [P in Perms]: DslPermissionToken<WireName, P>;
  };
  readonly child: <
    const ChildWire extends string,
    const Inherit extends DslInheritOption<Perms>,
    const RolesSpec extends DslRolesSpec = Record<never, never>,
    const CanResult extends Record<string, DslPermissionExpr> = Record<
      never,
      never
    >,
    const Recursive extends boolean = false,
    const GrandChildren extends Readonly<Record<string, AnyDslChildSpec>> =
      Record<never, never>,
  >(
    childWireName: ChildWire,
    childSpec: DslChildSpec<
      WireName,
      Perms,
      ChildWire,
      Inherit,
      RolesSpec,
      CanResult,
      Recursive,
      GrandChildren
    >,
  ) => ValidatedResourceResult<
    ChildWire,
    EffectiveRoleSubjects<
      ChildWire,
      RolesSpec,
      WireName,
      readonly [],
      Recursive
    >,
    ResolvedInheritedPerms<Perms, Inherit> | (keyof CanResult & string),
    GrandChildren
  >;
} & ChildrenMap;

export type DslNode = DslActor | AnyDslResource;

export type CompileAccessOptions = {
  readonly migrations?: readonly AccessMigrationMeta[];
  readonly bindings?: readonly ScopeBindings[];
  readonly visibleRecordExceptions?: readonly VisibleRecordException[];
};
