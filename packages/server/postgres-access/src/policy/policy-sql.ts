import { type AuthorizationModelDefinition } from "./policy-model.js";
import type { PostgresValue } from "../postgres-types.js";

/** The single relationship table every compiled policy statement reads. */
export const TUPLES = "dad_authorization_relationship";

/**
 * Collects every literal a compiled statement needs as an ordinal parameter and
 * hands out the distinct table aliases a nested `through` traversal joins on.
 */
export class QueryBuilder {
  readonly values: PostgresValue[] = [];
  #throughAliasCount = 0;

  value(value: PostgresValue): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }

  get throughCount(): number {
    return this.#throughAliasCount;
  }

  throughAlias(): string {
    const alias = `through_tuple_${String(this.#throughAliasCount)}`;
    this.#throughAliasCount += 1;
    return alias;
  }
}

/** Resolves the one entity a `through` relation may hop to. */
export function relatedEntity(
  model: AuthorizationModelDefinition,
  entity: string,
  relation: string,
): string {
  const definition = model.relations.find(
    (candidate) =>
      candidate.entity === entity && candidate.wireName === relation,
  );
  const targets = definition?.targets.filter(
    (target) => target.kind === "entity",
  );
  if (!targets || targets.length !== 1)
    throw new Error(
      `Postgres policy needs one entity target for through relation ${entity}.${relation}.`,
    );
  const target = targets[0];
  if (!target)
    throw new Error("Postgres policy is missing a through relation target.");
  return target.entity;
}

/** Reach all relationship usersets containing a concrete subject. */
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
        OFFSET 0
      ) parent
    )`;
}
