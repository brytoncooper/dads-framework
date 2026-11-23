import type {
  AuthorizationModelDefinition,
  CompiledPermissionExpression,
  NormalizedPermissionCheck,
} from "./policy-model.js";
import type { CompiledAuthorizationQuery } from "./compile-postgres-policy.js";
import { findColumnRelation } from "./column-relations.js";
import { notExpired, permissionIdentity, resolveArrowTargets, TUPLES } from "./policy-sql.js";

const MIN_FUSED_ARROWS = 4;
const MAX_FUSED_ARROWS = 32;
const MAX_TRAVERSED_STATES = 64;
const FALLBACK_THRESHOLD = MAX_TRAVERSED_STATES + 1;

export function compileLinearCheck(
  model: AuthorizationModelDefinition,
  namespace: string,
  check: NormalizedPermissionCheck,
): CompiledAuthorizationQuery | undefined {
  const path = readLinearPath(model, check.resource.type, check.permission);
  if (path === undefined) return undefined;
  return {
    kind: "check",
    text: SQL,
    values: [namespace, check.subject.type, check.subject.id, check.resource.type, check.resource.id, path],
  };
}

const terminal = "cardinality($6::text[])";

// UNION deduplicates each traversal state, including terminal userset cycles.
// Saturation produces NULL. Only a complete walk can produce a denial.
const SQL = `WITH RECURSIVE levels(ordinal, resource_kind, resource_id, relation) AS (
  SELECT 1, $4::text, $5::text, ($6::text[])[1]
  UNION
  SELECT CASE WHEN levels.ordinal < ${terminal} THEN levels.ordinal + 1 ELSE levels.ordinal END,
    tuple.subject_kind, tuple.subject_id,
    CASE WHEN levels.ordinal < ${terminal} THEN ($6::text[])[levels.ordinal + 1] ELSE tuple.subject_relation END
  FROM levels
  JOIN ${TUPLES} tuple
    ON tuple.namespace = $1 AND tuple.resource_kind = levels.resource_kind
    AND tuple.resource_id = levels.resource_id AND tuple.relation = levels.relation
  WHERE tuple.subject_is_wildcard = false
    AND ${notExpired("tuple")}
    AND (levels.ordinal < ${terminal}) = (tuple.subject_relation = '')
), bounded AS MATERIALIZED (
  SELECT * FROM levels LIMIT ${String(FALLBACK_THRESHOLD)}
)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM bounded
  JOIN ${TUPLES} tuple
    ON tuple.namespace = $1 AND tuple.resource_kind = bounded.resource_kind
    AND tuple.resource_id = bounded.resource_id AND tuple.relation = bounded.relation
  WHERE bounded.ordinal = ${terminal} AND tuple.subject_kind = $2
    AND tuple.subject_relation = ''
    AND ${notExpired("tuple")}
    AND ((tuple.subject_id = $3 AND tuple.subject_is_wildcard = false)
      OR (tuple.subject_id = '' AND tuple.subject_is_wildcard = true))
) THEN true
WHEN (SELECT count(*) FROM bounded) >= ${String(FALLBACK_THRESHOLD)} THEN NULL
ELSE false END AS allowed`;

export function readLinearPath(
  model: AuthorizationModelDefinition,
  resourceEntity: string,
  permission: string,
): readonly string[] | undefined {
  const arrows: string[] = [];
  const visited = new Set<string>();
  let entity = resourceEntity;
  let name = permission;
  while (arrows.length <= MAX_FUSED_ARROWS) {
    const identity = permissionIdentity(entity, name);
    if (visited.has(identity)) return undefined;
    visited.add(identity);
    const step = readLinearStep(model, entity, name);
    if (step === undefined) return undefined;
    if (step.kind === "leaf") {
      return arrows.length >= MIN_FUSED_ARROWS ? [...arrows, step.relation] : undefined;
    }
    arrows.push(step.relation);
    entity = step.nextEntity;
    name = step.nextPermission;
  }
  return undefined;
}

type LinearStep =
  | { readonly kind: "leaf"; readonly relation: string }
  | {
      readonly kind: "arrow";
      readonly relation: string;
      readonly nextEntity: string;
      readonly nextPermission: string;
    };

function isColumnBacked(model: AuthorizationModelDefinition, entity: string, relation: string): boolean {
  return findColumnRelation(model, entity, relation) !== undefined;
}

function readLinearStep(model: AuthorizationModelDefinition, entity: string, name: string): LinearStep | undefined {
  const expression = model.permissions.find(
    (candidate) => candidate.entity === entity && candidate.wireName === name,
  )?.expression;
  if (expression?.kind === "relation") {
    return isColumnBacked(model, entity, expression.relation)
      ? undefined
      : { kind: "leaf", relation: expression.relation };
  }
  if (expression?.kind !== "through") return undefined;
  return readLinearArrowStep(model, entity, expression);
}

function readLinearArrowStep(
  model: AuthorizationModelDefinition,
  entity: string,
  expression: Extract<CompiledPermissionExpression, { readonly kind: "through" }>,
): LinearStep | undefined {
  if (
    isColumnBacked(model, entity, expression.relation) ||
    !hasSingleEntityTarget(model, entity, expression.relation)
  ) {
    return undefined;
  }
  const targets = resolveArrowTargets(model, entity, expression);
  const [only] = targets;
  if (targets.length !== 1 || only === undefined) return undefined;
  return {
    kind: "arrow",
    relation: expression.relation,
    nextEntity: only.entity,
    nextPermission: only.permission,
  };
}

function hasSingleEntityTarget(model: AuthorizationModelDefinition, entity: string, relation: string): boolean {
  const definition = model.relations.find(
    (candidate) => candidate.entity === entity && candidate.wireName === relation,
  );
  const entityTargets = definition?.targets.filter((target) => target.kind === "entity") ?? [];
  return entityTargets.length === 1;
}
