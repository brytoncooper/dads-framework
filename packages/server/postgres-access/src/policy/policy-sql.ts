import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledPermissionExpression,
} from "./policy-model.js";
import type { PostgresValue } from "../postgres-types.js";

/** The single relationship table every compiled policy statement reads. */
export const TUPLES = "dad_authorization_relationship";

/** Stable map key for one `(entity, permission)` pair. */
export function permissionIdentity(entity: string, permission: string): string {
  return `${entity}\u0000${permission}`;
}

/** True when a tuple has no expiration or expires strictly after transaction start. */
export function notExpired(alias: string): string {
  return `(${alias}.expires_at IS NULL OR ${alias}.expires_at > now())`;
}

/**
 * Collects every literal a compiled statement needs as an ordinal parameter and
 * hands out the distinct table aliases a nested `through` traversal joins on.
 */
export class QueryBuilder {
  readonly values: PostgresValue[] = [];
  #throughAliasCount = 0;
  #cteAliasCount = 0;
  #hasRecursive = false;

  value(value: PostgresValue): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
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

type ArrowExpression = Extract<
  CompiledPermissionExpression,
  { readonly kind: "through" | "through-all" }
>;

/** True when a relation declares more than one direct entity target type. */
export function isPolymorphicRelation(
  model: AuthorizationModelDefinition,
  entity: string,
  relation: string,
): boolean {
  const definition = model.relations.find(
    (candidate) =>
      candidate.entity === entity && candidate.wireName === relation,
  );
  const entityTargets =
    definition?.targets.filter((target) => target.kind === "entity") ?? [];
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
      throw new Error(
        `Postgres policy is missing arrow targets for ${entity}.${expression.relation}.`,
      );
    }
    return expression.targets;
  }
  const definition = model.relations.find(
    (candidate) =>
      candidate.entity === entity && candidate.wireName === expression.relation,
  );
  const entityTargets =
    definition?.targets.filter((target) => target.kind === "entity") ?? [];
  const resolved = entityTargets
    .filter((target) =>
      model.permissions.some(
        (candidate) =>
          candidate.entity === target.entity &&
          candidate.wireName === expression.permission,
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

/** Reach all non-expired relationship usersets containing a concrete subject. */
export function subjectReachability(
  namespace: string,
  subjectKind: string,
  subjectId: string,
): string {
  return `subject_reachable(resource_kind, resource_id, relation) AS (
      SELECT direct_tuple.resource_kind, direct_tuple.resource_id, direct_tuple.relation
      FROM ${TUPLES} direct_tuple
      WHERE direct_tuple.namespace = ${namespace}
        AND direct_tuple.subject_relation = ''
        AND ${notExpired("direct_tuple")}
        AND ((direct_tuple.subject_is_wildcard = false AND direct_tuple.subject_kind = ${subjectKind} AND direct_tuple.subject_id = ${subjectId}) OR (direct_tuple.subject_is_wildcard = true AND direct_tuple.subject_kind = ${subjectKind}))
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
