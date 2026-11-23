import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledColumnRelation,
  CompiledPermissionExpression,
} from "./policy-model.js";
import type { PostgresValue } from "../postgres-types.js";
import { findColumnRelation } from "./column-relations.js";

/** The single relationship table every compiled policy statement reads. */
export const TUPLES = "dad_authorization_relationship";

/** Stable map key for one `(entity, permission)` pair. */
export function permissionIdentity(entity: string, permission: string): string {
  return `${entity}\u0000${permission}`;
}

/** Split a `permissionIdentity` key back into `[entity, permission]`. */
export function splitIdentity(value: string): readonly [string, string] {
  const index = value.indexOf("\u0000");
  return [value.slice(0, index), value.slice(index + 1)];
}

/** True when a tuple has no expiration or expires strictly after transaction start. */
export function notExpired(alias: string): string {
  return `(${alias}.expires_at IS NULL OR ${alias}.expires_at > now())`;
}

/** Lazily allocates and caches a single `$N` placeholder when first referenced in SQL. */
export type LazySqlParam = () => string;

/**
 * Collects every literal a compiled statement needs as an ordinal parameter and
 * hands out the distinct table aliases a nested `through` traversal joins on.
 */
export class QueryBuilder {
  readonly values: PostgresValue[] = [];
  readonly #paramOffset: number;
  #throughAliasCount = 0;
  #cteAliasCount = 0;
  #hasRecursive = false;

  constructor(paramOffset = 1) {
    this.#paramOffset = paramOffset;
  }

  value(value: PostgresValue): string {
    const index = this.#paramOffset + this.values.length;
    this.values.push(value);
    return `$${String(index)}`;
  }

  lazyValue(value: PostgresValue): LazySqlParam {
    let placeholder: string | undefined;
    return () => {
      placeholder ??= this.value(value);
      return placeholder;
    };
  }

  get throughCount(): number {
    return this.#throughAliasCount;
  }

  get hasRecursive(): boolean {
    return this.#hasRecursive;
  }

  markRecursive(): void {
    this.#hasRecursive = true;
  }

  throughAlias(): string {
    const alias = `through_tuple_${String(this.#throughAliasCount)}`;
    this.#throughAliasCount += 1;
    return alias;
  }

  cteAlias(prefix: string): string {
    const alias = `${prefix}_${String(this.#cteAliasCount)}`;
    this.#cteAliasCount += 1;
    return alias;
  }
}

type ArrowExpression = Extract<CompiledPermissionExpression, { readonly kind: "through" | "through-all" }>;

/** True when a relation declares more than one direct entity target type. */
export function isPolymorphicRelation(model: AuthorizationModelDefinition, entity: string, relation: string): boolean {
  const definition = model.relations.find(
    (candidate) => candidate.entity === entity && candidate.wireName === relation,
  );
  const entityTargets = definition?.targets.filter((target) => target.kind === "entity") ?? [];
  return entityTargets.length > 1;
}

/** Resolves all direct entity targets defining the permission for an arrow. */
export function resolveArrowTargets(
  model: AuthorizationModelDefinition,
  entity: string,
  expression: ArrowExpression,
): readonly CompiledArrowTarget[] {
  if (expression.targets !== undefined) {
    if (expression.targets.length === 0) {
      throw new Error(`Postgres policy is missing arrow targets for ${entity}.${expression.relation}.`);
    }
    return expression.targets;
  }
  const definition = model.relations.find(
    (candidate) => candidate.entity === entity && candidate.wireName === expression.relation,
  );
  const entityTargets = definition?.targets.filter((target) => target.kind === "entity") ?? [];
  const resolved = entityTargets
    .filter((target) =>
      model.permissions.some(
        (candidate) => candidate.entity === target.entity && candidate.wireName === expression.permission,
      ),
    )
    .map((target) => ({
      entity: target.entity,
      permission: expression.permission,
    }));
  if (resolved.length === 0) {
    throw new Error(
      `Postgres policy is missing a through permission for ${entity}.${expression.relation}->${expression.permission}.`,
    );
  }
  return resolved;
}

/** True when any relation in the model accepts a userset (`entity#relation`) subject. */
export function modelHasUsersetTargets(model: AuthorizationModelDefinition): boolean {
  return model.relations.some((relation) => relation.targets.some((target) => target.kind === "subject-set"));
}

/** Describes whether a specific `(entity, relation)` accepts userset or wildcard subjects. */
export function relationTargetCapabilities(
  model: AuthorizationModelDefinition,
  entity: string,
  relation: string,
): { readonly allowsUsersets: boolean; readonly allowsWildcards: boolean } {
  const definition = model.relations.find(
    (candidate) => candidate.entity === entity && candidate.wireName === relation,
  );
  if (definition === undefined) {
    return { allowsUsersets: true, allowsWildcards: true };
  }
  return {
    allowsUsersets: definition.targets.some((target) => target.kind === "subject-set"),
    allowsWildcards: definition.targets.some((target) => target.kind === "wildcard"),
  };
}

/** Dispatches to column-backed FK lookup, direct PK lookup, or recursive userset membership. */
export function compiledRelationCheck(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: LazySqlParam,
  subjectKind: string,
  subjectId: string,
  resourceEntity: string,
  resourceKind: string,
  resourceId: string,
  relationName: string,
): string {
  const columnRel = findColumnRelation(model, resourceEntity, relationName);
  if (columnRel !== undefined) {
    const entitySql = builder.value(columnRel.entity);
    const targetKindSql = builder.value(columnRel.targetEntity);
    return `EXISTS (SELECT 1
      FROM ${columnRel.table} col_tuple
      WHERE (${resourceKind})::text = ${entitySql}::text
        AND (${subjectKind})::text = ${targetKindSql}::text
        AND col_tuple.${columnRel.idColumn}::text = (${resourceId})::text
        AND col_tuple.${columnRel.targetIdColumn}::text = (${subjectId})::text)`;
  }
  const namespaceSql = namespace();
  const relationSql = builder.value(relationName);
  const { allowsUsersets, allowsWildcards } = relationTargetCapabilities(model, resourceEntity, relationName);
  // Top-level concrete checks (and checkMany input rows) always bind a declared
  // entity wireName, so per-relation userset analysis is exact even when other
  // relations in the model use subject-sets. Unchecked arrow subject_kind hops
  // fall back to model-wide userset detection.
  const isDeclaredEntityBinding = resourceKind.startsWith("$") || resourceKind === "i.resource_kind";
  const skipUsersetRecursion = isDeclaredEntityBinding ? !allowsUsersets : !modelHasUsersetTargets(model);
  if (skipUsersetRecursion) {
    return directRelationMembershipCheck(
      namespaceSql,
      subjectKind,
      subjectId,
      resourceKind,
      resourceId,
      relationSql,
      allowsWildcards,
    );
  }
  return relationMembershipCheck(namespaceSql, subjectKind, subjectId, resourceKind, resourceId, relationSql);
}

/** Direct primary-key membership check when a relation has no userset targets. */
export function directRelationMembershipCheck(
  namespace: string,
  subjectKind: string,
  subjectId: string,
  resourceKind: string,
  resourceId: string,
  relationSql: string,
  allowsWildcards: boolean,
): string {
  const subjectCondition = allowsWildcards
    ? `((tuple.subject_id = ${subjectId} AND tuple.subject_is_wildcard = false) OR (tuple.subject_id = '' AND tuple.subject_is_wildcard = true))`
    : `tuple.subject_id = ${subjectId} AND tuple.subject_is_wildcard = false`;
  return `EXISTS (SELECT 1
    FROM ${TUPLES} tuple
    WHERE tuple.namespace = ${namespace}
      AND tuple.resource_kind = ${resourceKind}
      AND tuple.resource_id = ${resourceId}
      AND tuple.relation = ${relationSql}
      AND tuple.subject_kind = ${subjectKind}
      AND tuple.subject_relation = ''
      AND ${subjectCondition}
      AND ${notExpired("tuple")})`;
}

function columnRelationDirectBranches(
  columnRelations: readonly CompiledColumnRelation[] | undefined,
  builder: QueryBuilder | undefined,
  subjectKind: string,
  subjectId: string,
): string {
  if (columnRelations === undefined || columnRelations.length === 0 || builder === undefined) {
    return "";
  }
  return columnRelations
    .map((col) => {
      const entitySql = builder.value(col.entity);
      const relationSql = builder.value(col.relation);
      const targetKindSql = builder.value(col.targetEntity);
      return ` UNION ALL SELECT ${entitySql}::text, col_direct.${col.idColumn}::text, ${relationSql}::text
        FROM ${col.table} col_direct
        WHERE (${subjectKind})::text = ${targetKindSql}::text
          AND col_direct.${col.targetIdColumn}::text = (${subjectId})::text`;
    })
    .join("");
}

/** Reach all non-expired direct and wildcard tuples for a subject (no userset recursion). */
export function directSubjectReachability(
  namespace: string,
  subjectKind: string,
  subjectId: string,
  columnRelations?: readonly CompiledColumnRelation[],
  builder?: QueryBuilder,
): string {
  const columnBranches = columnRelationDirectBranches(columnRelations, builder, subjectKind, subjectId);
  return `subject_reachable(resource_kind, resource_id, relation) AS (
      SELECT direct_tuple.resource_kind, direct_tuple.resource_id, direct_tuple.relation
      FROM ${TUPLES} direct_tuple
      WHERE direct_tuple.namespace = ${namespace}
        AND direct_tuple.subject_relation = ''
        AND ${notExpired("direct_tuple")}
        AND ((direct_tuple.subject_is_wildcard = false AND direct_tuple.subject_kind = ${subjectKind} AND direct_tuple.subject_id = ${subjectId}) OR (direct_tuple.subject_is_wildcard = true AND direct_tuple.subject_kind = ${subjectKind} AND direct_tuple.subject_id = ''))${columnBranches}
    )`;
}

/** Reach all non-expired relationship usersets containing a concrete subject. */
export function subjectReachability(
  namespace: string,
  subjectKind: string,
  subjectId: string,
  columnRelations?: readonly CompiledColumnRelation[],
  builder?: QueryBuilder,
): string {
  const columnBranches = columnRelationDirectBranches(columnRelations, builder, subjectKind, subjectId);
  return `subject_reachable(resource_kind, resource_id, relation) AS (
      SELECT direct_tuple.resource_kind, direct_tuple.resource_id, direct_tuple.relation
      FROM ${TUPLES} direct_tuple
      WHERE direct_tuple.namespace = ${namespace}
        AND direct_tuple.subject_relation = ''
        AND ${notExpired("direct_tuple")}
        AND ((direct_tuple.subject_is_wildcard = false AND direct_tuple.subject_kind = ${subjectKind} AND direct_tuple.subject_id = ${subjectId}) OR (direct_tuple.subject_is_wildcard = true AND direct_tuple.subject_kind = ${subjectKind} AND direct_tuple.subject_id = ''))${columnBranches}
      UNION
      SELECT parent.resource_kind, parent.resource_id, parent.relation
      FROM subject_reachable child_relation
      CROSS JOIN LATERAL (
        SELECT tuple.resource_kind, tuple.resource_id, tuple.relation
        FROM ${TUPLES} tuple
        WHERE tuple.namespace = ${namespace}
          AND tuple.subject_kind = child_relation.resource_kind
          AND tuple.subject_id = child_relation.resource_id
          AND tuple.subject_relation = child_relation.relation
          AND tuple.subject_is_wildcard = false
          AND tuple.subject_relation <> ''
          AND ${notExpired("tuple")}
        OFFSET 0
      ) parent
    )`;
}

/**
 * Checks direct, wildcard, or recursive userset membership on one relation.
 * UNION deduplicates usersets, including cycles and diamonds.
 */
export function relationMembershipCheck(
  namespace: string,
  subjectKind: string,
  subjectId: string,
  resourceKind: string,
  resourceId: string,
  relationSql: string,
): string {
  return `EXISTS (WITH RECURSIVE requested(resource_kind, resource_id, relation) AS (
    VALUES (${resourceKind}, ${resourceId}, ${relationSql})
    UNION
    SELECT child.subject_kind, child.subject_id, child.subject_relation
    FROM requested requested_relation
    CROSS JOIN LATERAL (
      SELECT tuple.subject_kind, tuple.subject_id, tuple.subject_relation
      FROM ${TUPLES} tuple
      WHERE tuple.namespace = ${namespace}
        AND tuple.resource_kind = requested_relation.resource_kind
        AND tuple.resource_id = requested_relation.resource_id
        AND tuple.relation = requested_relation.relation
        AND tuple.subject_is_wildcard = false
        AND tuple.subject_relation <> ''
        AND ${notExpired("tuple")}
      OFFSET 0
    ) child
  )
  SELECT 1
  FROM ${TUPLES} tuple
  JOIN requested requested_relation
    ON requested_relation.resource_kind = tuple.resource_kind
    AND requested_relation.resource_id = tuple.resource_id
    AND requested_relation.relation = tuple.relation
  WHERE tuple.namespace = ${namespace}
    AND ${notExpired("tuple")}
    AND ((tuple.subject_is_wildcard = false AND tuple.subject_relation = '' AND tuple.subject_kind = ${subjectKind} AND tuple.subject_id = ${subjectId}) OR (tuple.subject_is_wildcard = true AND tuple.subject_kind = ${subjectKind}))
  LIMIT 1)`;
}
