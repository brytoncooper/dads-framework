export type SqliteArrowTarget = {
  readonly entity: string;
  readonly permission: string;
};

export type SqlitePermissionExpression =
  | { readonly kind: "relation"; readonly relation: string }
  | {
      readonly kind: "any-of";
      readonly expressions: readonly SqlitePermissionExpression[];
    }
  | {
      readonly kind: "all-of";
      readonly expressions: readonly SqlitePermissionExpression[];
    }
  | {
      readonly kind: "through";
      readonly relation: string;
      readonly targets: readonly SqliteArrowTarget[];
    }
  | {
      readonly kind: "through-all";
      readonly relation: string;
      readonly targets: readonly SqliteArrowTarget[];
    }
  | {
      readonly kind: "exclude";
      readonly include: SqlitePermissionExpression;
      readonly exclude: SqlitePermissionExpression;
    };

export type SqliteAuthorizationEntity = {
  readonly sourceName: string;
  readonly wireName: string;
};

export type SqliteRelationTarget =
  | { readonly kind: "entity"; readonly entity: string }
  | { readonly kind: "wildcard"; readonly entity: string }
  | {
      readonly kind: "subject-set";
      readonly entity: string;
      readonly relation: string;
    };

export type SqliteAuthorizationRelation = {
  readonly entity: string;
  readonly sourceName: string;
  readonly wireName: string;
  readonly targets: readonly SqliteRelationTarget[];
};

export type SqliteAuthorizationPermission = {
  readonly entity: string;
  readonly sourceName: string;
  readonly wireName: string;
  readonly expression: SqlitePermissionExpression;
};

export type GuardCondition = {
  readonly positive: boolean;
  readonly expression: SqlitePermissionExpression;
};

export type RecursiveBaseClause = {
  readonly kind: "base";
  readonly entity: string;
  readonly permission: string;
  readonly expression: SqlitePermissionExpression;
};

export type RecursiveStepClause = {
  readonly kind: "step";
  readonly entity: string;
  readonly permission: string;
  readonly relation: string;
  readonly targetEntity: string;
  readonly targetPermission: string;
  readonly guards: readonly GuardCondition[];
};

export type CompiledCyclicScc = {
  readonly id: number;
  readonly members: ReadonlySet<string>;
  readonly baseClauses: readonly RecursiveBaseClause[];
  readonly stepClauses: readonly RecursiveStepClause[];
};

/** Internal lowered SQLite model compiled from `@dads-framework/access` IR. */
export type SqliteAuthorizationModel = {
  readonly entities: readonly SqliteAuthorizationEntity[];
  readonly relations: readonly SqliteAuthorizationRelation[];
  readonly permissions: readonly SqliteAuthorizationPermission[];
  readonly permissionByKey: ReadonlyMap<string, SqliteAuthorizationPermission>;
  readonly cyclicSccsByKey: ReadonlyMap<string, CompiledCyclicScc>;
};

export type SqliteEntityRef = {
  readonly type: string;
  readonly id: string;
};

export type SqlitePermissionCheck = {
  readonly subject: SqliteEntityRef;
  readonly permission: string;
  readonly resource: SqliteEntityRef;
};

export type SqliteResourceLookup = {
  readonly subject: SqliteEntityRef;
  readonly permission: string;
  readonly resourceType: string;
};

export type SqliteSubjectLookup = {
  readonly resource: SqliteEntityRef;
  readonly permission: string;
  readonly subjectType: string;
};

/** Stable composite key for one `(entity, permission)` pair. */
export function permissionKey(entity: string, permission: string): string {
  return `${entity}\u0000${permission}`;
}

/** Split a `permissionKey` back into `[entity, permission]`. */
export function splitPermissionKey(value: string): readonly [string, string] {
  const index = value.indexOf("\u0000");
  return [value.slice(0, index), value.slice(index + 1)];
}
