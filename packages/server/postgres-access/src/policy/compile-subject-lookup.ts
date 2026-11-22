import type { CompiledAuthorizationQuery } from "./compile-postgres-policy.js";
import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledPermissionExpression,
  NormalizedSubjectLookup,
} from "./policy-model.js";
import {
  analyzePermissionCycles,
  type PermissionCyclePlan,
} from "./permission-cycles.js";
import {
  compileRecursiveSubjectLookup,
  type SubjectResourceRef,
} from "./compile-recursive-subjects.js";
import {
  notExpired,
  permissionIdentity,
  QueryBuilder,
  resolveArrowTargets,
  TUPLES,
} from "./policy-sql.js";

type SubjectContext = {
  readonly model: AuthorizationModelDefinition;
  readonly cycles: PermissionCyclePlan;
  readonly builder: QueryBuilder;
  readonly namespace: string;
  readonly subjectType: string;
  readonly active: Set<string>;
};

/**
 * Compiles one transitive subject lookup into a single parameterized SQL query
 * returning `(subject_id, is_wildcard)` rows.
 */
export function compilePostgresSubjectLookup(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedSubjectLookup,
): CompiledAuthorizationQuery {
  const builder = new QueryBuilder();
  const context: SubjectContext = {
    model,
    cycles: analyzePermissionCycles(model),
    builder,
    namespace: builder.value(namespace),
    subjectType: builder.value(request.subjectType),
    active: new Set(),
  };
  const resource: SubjectResourceRef = {
    type: builder.value(request.resource.type),
    id: builder.value(request.resource.id),
    entity: request.resource.type,
  };
  const body = compileSubjectPermission(context, resource, request.permission);
  return Object.freeze({
    kind: "subject-lookup",
    text: `SELECT DISTINCT result.subject_id, result.is_wildcard FROM (${body}) result ORDER BY result.is_wildcard, result.subject_id`,
    values: builder.values,
  });
}

function compileSubjectPermission(
  context: SubjectContext,
  resource: SubjectResourceRef,
  permissionName: string,
): string {
  const definition = context.model.permissions.find(
    (candidate) =>
      candidate.wireName === permissionName &&
      candidate.entity === resource.entity,
  );
  if (!definition)
    throw new Error(
      `Postgres policy cannot find permission ${permissionName}.`,
    );
  const scc = context.cycles.sccFor(resource.entity, permissionName);
  if (scc !== undefined) {
    return compileRecursiveSubjectLookup({
      builder: context.builder,
      namespace: context.namespace,
      resource,
      entryPermission: permissionName,
      scc,
      compileExpr: (ref, expression) =>
        compileSubjectExpression(context, ref, expression),
      compileAllOf: (ref, expressions) =>
        compileAllOfSubjects(context, ref, expressions),
    });
  }
  const identity = permissionIdentity(resource.entity, permissionName);
  if (context.active.has(identity))
    throw new Error(
      "Postgres SQL compilation does not support a cycle through permissions.",
    );
  context.active.add(identity);
  try {
    return compileSubjectExpression(context, resource, definition.expression);
  } finally {
    context.active.delete(identity);
  }
}

function compileSubjectExpression(
  context: SubjectContext,
  resource: SubjectResourceRef,
  expression: CompiledPermissionExpression,
): string {
  if (expression.kind === "relation")
    return compileRelationSubjects(context, resource, expression.relation);
  if (expression.kind === "through")
    return compileThroughSubjects(context, resource, expression);
  if (expression.kind === "through-all")
    return compileThroughAllSubjects(context, resource, expression);
  if (expression.kind === "exclude")
    return compileExcludeSubjects(context, resource, expression);
  if (expression.kind === "any-of") {
    return expression.expressions
      .map((child) => `(${compileSubjectExpression(context, resource, child)})`)
      .join(" UNION ");
  }
  return compileAllOfSubjects(context, resource, expression.expressions);
}

function compileRelationSubjects(
  context: SubjectContext,
  resource: SubjectResourceRef,
  relation: string,
): string {
  const { builder, namespace, subjectType } = context;
  const reqAlias = builder.cteAlias("req");
  const relationSql = builder.value(relation);
  return `WITH RECURSIVE ${reqAlias}(resource_kind, resource_id, relation) AS (
    VALUES ((${resource.type})::text, (${resource.id})::text, ${relationSql}::text)
    UNION
    SELECT child.subject_kind, child.subject_id, child.subject_relation
    FROM ${reqAlias} requested_relation
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
  SELECT DISTINCT
    CASE WHEN tuple.subject_is_wildcard THEN '' ELSE tuple.subject_id END AS subject_id,
    tuple.subject_is_wildcard AS is_wildcard
  FROM ${TUPLES} tuple
  JOIN ${reqAlias} requested_relation
    ON requested_relation.resource_kind = tuple.resource_kind
    AND requested_relation.resource_id = tuple.resource_id
    AND requested_relation.relation = tuple.relation
  WHERE tuple.namespace = ${namespace}
    AND tuple.subject_kind = ${subjectType}
    AND tuple.subject_relation = ''
    AND ${notExpired("tuple")}`;
}

function compileAllOfSubjects(
  context: SubjectContext,
  resource: SubjectResourceRef,
  expressions: readonly CompiledPermissionExpression[],
): string {
  const [first, ...rest] = expressions;
  if (first === undefined) {
    return "SELECT ''::text AS subject_id, false AS is_wildcard WHERE false";
  }
  let current = compileSubjectExpression(context, resource, first);
  for (const next of rest) {
    const right = compileSubjectExpression(context, resource, next);
    current = intersectSubjectQueries(context.builder, current, right);
  }
  return current;
}

function intersectSubjectQueries(
  builder: QueryBuilder,
  leftSql: string,
  rightSql: string,
): string {
  const leftAlias = builder.cteAlias("sub_l");
  const rightAlias = builder.cteAlias("sub_r");
  return `WITH ${leftAlias} AS (${leftSql}), ${rightAlias} AS (${rightSql})
    SELECT l.subject_id, l.is_wildcard
    FROM ${leftAlias} l
    WHERE EXISTS (
      SELECT 1 FROM ${rightAlias} r
      WHERE (r.is_wildcard AND l.is_wildcard)
        OR (NOT l.is_wildcard AND (r.is_wildcard OR (NOT r.is_wildcard AND r.subject_id = l.subject_id)))
    )
    UNION
    SELECT r.subject_id, r.is_wildcard
    FROM ${rightAlias} r
    WHERE NOT r.is_wildcard
      AND EXISTS (SELECT 1 FROM ${leftAlias} l WHERE l.is_wildcard)`;
}

function compileExcludeSubjects(
  context: SubjectContext,
  resource: SubjectResourceRef,
  expression: Extract<CompiledPermissionExpression, { kind: "exclude" }>,
): string {
  const incAlias = context.builder.cteAlias("sub_inc");
  const excAlias = context.builder.cteAlias("sub_exc");
  const includeSql = compileSubjectExpression(
    context,
    resource,
    expression.include,
  );
  const excludeSql = compileSubjectExpression(
    context,
    resource,
    expression.exclude,
  );
  return `WITH ${incAlias} AS (${includeSql}), ${excAlias} AS (${excludeSql})
    SELECT inc.subject_id, inc.is_wildcard
    FROM ${incAlias} inc
    WHERE NOT EXISTS (SELECT 1 FROM ${excAlias} exc WHERE exc.is_wildcard)
      AND (
        inc.is_wildcard
        OR NOT EXISTS (
          SELECT 1 FROM ${excAlias} exc
          WHERE NOT exc.is_wildcard AND exc.subject_id = inc.subject_id
        )
      )`;
}

function compileThroughSubjects(
  context: SubjectContext,
  resource: SubjectResourceRef,
  expression: Extract<CompiledPermissionExpression, { kind: "through" }>,
): string {
  const { builder, namespace } = context;
  const targets = resolveArrowTargets(
    context.model,
    resource.entity,
    expression,
  );
  const throughAlias = builder.throughAlias();
  const relationSql = builder.value(expression.relation);
  const targetSql = compileTargetSubjectBranches(
    context,
    `${throughAlias}.subject_kind`,
    `${throughAlias}.subject_id`,
    targets,
  );
  return `SELECT DISTINCT sub.subject_id, sub.is_wildcard
    FROM ${TUPLES} ${throughAlias}
    CROSS JOIN LATERAL (${targetSql}) sub
    WHERE ${throughAlias}.namespace = ${namespace}
      AND ${throughAlias}.resource_kind = ${resource.type}
      AND ${throughAlias}.resource_id = ${resource.id}
      AND ${throughAlias}.relation = ${relationSql}
      AND ${throughAlias}.subject_is_wildcard = false
      AND ${throughAlias}.subject_relation = ''
      AND ${notExpired(throughAlias)}`;
}

function compileThroughAllSubjects(
  context: SubjectContext,
  resource: SubjectResourceRef,
  expression: Extract<CompiledPermissionExpression, { kind: "through-all" }>,
): string {
  const { builder, namespace } = context;
  const targets = resolveArrowTargets(
    context.model,
    resource.entity,
    expression,
  );
  const tupleAlias = builder.throughAlias();
  const parentsAlias = builder.cteAlias("all_parents");
  const subjectsAlias = builder.cteAlias("all_parent_subjects");
  const relationSql = builder.value(expression.relation);
  const targetSql = compileTargetSubjectBranches(
    context,
    "p.parent_kind",
    "p.parent_id",
    targets,
  );
  return `WITH ${parentsAlias} AS (
      SELECT ${tupleAlias}.subject_kind AS parent_kind, ${tupleAlias}.subject_id AS parent_id
      FROM ${TUPLES} ${tupleAlias}
      WHERE ${tupleAlias}.namespace = ${namespace}
        AND ${tupleAlias}.resource_kind = ${resource.type}
        AND ${tupleAlias}.resource_id = ${resource.id}
        AND ${tupleAlias}.relation = ${relationSql}
        AND ${tupleAlias}.subject_is_wildcard = false
        AND ${tupleAlias}.subject_relation = ''
        AND ${notExpired(tupleAlias)}
    ),
    ${subjectsAlias} AS (
      SELECT p.parent_kind, p.parent_id, sub.subject_id, sub.is_wildcard
      FROM ${parentsAlias} p
      CROSS JOIN LATERAL (${targetSql}) sub
    )
    SELECT DISTINCT cand.subject_id, cand.is_wildcard
    FROM ${subjectsAlias} cand
    WHERE EXISTS (SELECT 1 FROM ${parentsAlias})
      AND NOT EXISTS (
        SELECT 1 FROM ${parentsAlias} p
        WHERE NOT EXISTS (
          SELECT 1 FROM ${subjectsAlias} ps
          WHERE ps.parent_kind = p.parent_kind
            AND ps.parent_id = p.parent_id
            AND (
              (cand.is_wildcard AND ps.is_wildcard)
              OR (NOT cand.is_wildcard AND (ps.is_wildcard OR (NOT ps.is_wildcard AND ps.subject_id = cand.subject_id)))
            )
        )
      )`;
}

function compileTargetSubjectBranches(
  context: SubjectContext,
  kindExpr: string,
  idExpr: string,
  targets: readonly CompiledArrowTarget[],
): string {
  return targets
    .map((target) => {
      const targetKindSql = context.builder.value(target.entity);
      const childSql = compileSubjectPermission(
        context,
        { type: kindExpr, id: idExpr, entity: target.entity },
        target.permission,
      );
      return `SELECT s.subject_id, s.is_wildcard FROM (${childSql}) s WHERE ${kindExpr} = ${targetKindSql}`;
    })
    .join(" UNION ");
}
