export type CompiledPermissionExpression =
  | { readonly kind: "relation"; readonly relation: string }
  | {
      readonly kind: "any-of" | "all-of";
      readonly expressions: readonly CompiledPermissionExpression[];
    }
  | {
      readonly kind: "through";
      readonly relation: string;
      readonly permission: string;
    }
  | {
      readonly kind: "exclude";
      readonly include: CompiledPermissionExpression;
      readonly exclude: CompiledPermissionExpression;
    };

export type CompiledAuthorizationEntity = {
  readonly sourceName: string;
  readonly wireName: string;
};

export type CompiledAuthorizationRelationTarget =
  | { readonly kind: "entity"; readonly entity: string }
  | { readonly kind: "wildcard"; readonly entity: string }
  | {
      readonly kind: "subject-set";
      readonly entity: string;
      readonly relation: string;
    };

export type CompiledAuthorizationRelation = {
  readonly authority: "system" | "grantable";
  readonly entity: string;
  readonly sourceName: string;
  readonly wireName: string;
  readonly targets: readonly CompiledAuthorizationRelationTarget[];
  /** Present only for RBAC role declarations; absence remains an ordinary relation. */
  readonly definitionType?: "role";
  readonly grantPermission?: CompiledGrantPermission;
  readonly revokePermission?: CompiledGrantPermission;
  readonly grantScopeRelation?: string;
};

export type CompiledGrantPermission = {
  readonly entity: string;
  readonly permission: string;
};

export type CompiledAuthorizationPermission = {
  readonly entity: string;
  readonly sourceName: string;
  readonly wireName: string;
  readonly expression: CompiledPermissionExpression;
};

/** Internal, lowered SQL model. Access-kit definitions are the public model. */
export type AuthorizationModelDefinition = {
  readonly entities: readonly CompiledAuthorizationEntity[];
  readonly relations: readonly CompiledAuthorizationRelation[];
  readonly permissions: readonly CompiledAuthorizationPermission[];
  readonly lifecycle: readonly { readonly name: string }[];
};
export type NormalizedAuthorizationReference = {
  readonly type: string;
  readonly id: string;
};

export type NormalizedRelationship = {
  readonly subject:
    | (NormalizedAuthorizationReference & {
        readonly relation?: string;
      })
    | { readonly type: string; readonly wildcard: true };
  readonly relation: string;
  readonly resource: NormalizedAuthorizationReference;
};

export type NormalizedPermissionCheck = {
  readonly subject: NormalizedAuthorizationReference;
  readonly permission: string;
  readonly resource: NormalizedAuthorizationReference;
};

export type NormalizedResourceLookup = {
  readonly subject: NormalizedAuthorizationReference;
  readonly permission: string;
  readonly resourceType: string;
};
