import type { SqliteQuery } from "../sqlite-types.js";
import { findSqliteColumnRelation } from "./column-relations.js";
import {
  columnChunk,
  compileForwardArrowTargets,
  compileForwardColumnArrowTargets,
  literalChunk,
  type ForwardCompileContext,
  type SqlSubject,
} from "./compile-check.js";
import { ensureReverseSccCte } from "./compile-lookup-resources-scc.js";
import {
  permissionKey,
  type SqliteAuthorizationModel,
  type SqliteArrowTarget,
  type SqlitePermissionExpression,
  type SqliteResourceLookup,
} from "./policy-model.js";
import {
  activeTupleCondition,
  joinChunks,
  modelHasSubjectSetTargets,
  QueryBuilder,
  subjectReachabilityCte,
  TUPLES,
} from "./policy-sql.js";

type ReverseContext = {
  readonly model: SqliteAuthorizationModel;
  readonly namespace: string;
  readonly nowMs: number;
  readonly subject: SqlSubject;
  readonly forward: ForwardCompileContext;
  readonly sccCteNames: Map<number, string>;
  readonly extraCtes: SqliteQuery[];
  readonly nextAlias: (prefix: string) => string;
  readonly deduplicate: boolean;
};

export type SqliteLookupSubqueryOptions = {
  /** Skip redundant `DISTINCT`/`UNION` passes when evaluated inside `IN (...)`. */
  readonly deduplicate?: boolean;
};

/** Compile reverse `lookupResources` returning all matching `resource_id`s in sorted order. */
export function compileSqliteLookupResources(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqliteResourceLookup,
): SqliteQuery {
  const subquery = compileSqliteLookupSubquery(
    model,
    namespace,
    nowMs,
    request,
  );
  return Object.freeze({
    sql: `${subquery.sql} ORDER BY allowed_resource.resource_id`,
    params: subquery.params,
  });
}

/** Compile reverse `lookupResources` as an unordered subquery suitable for `IN (...)`. */
export function compileSqliteLookupSubquery(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqliteResourceLookup,
  options?: SqliteLookupSubqueryOptions,
): SqliteQuery {
  return compileSqliteReverseSubquery(
    model,
    namespace,
    nowMs,
    request.subject,
    options,
    (context) =>
      compileReversePermission(
        context,
        request.resourceType,
        request.permission,
      ),
  );
}

/** Compile one reverse permission expression into an unordered subquery for `IN (...)`. */
export function compileSqliteExpressionSubquery(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  subjectRef: SqliteResourceLookup["subject"],
  entity: string,
  expression: SqlitePermissionExpression,
  options?: SqliteLookupSubqueryOptions,
): SqliteQuery {
  return compileSqliteReverseSubquery(
    model,
    namespace,
    nowMs,
    subjectRef,
    options,
    (context) => compileReverseExpression(context, entity, expression),
  );
}

function compileSqliteReverseSubquery(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  subjectRef: SqliteResourceLookup["subject"],
  options: SqliteLookupSubqueryOptions | undefined,
  compileBody: (context: ReverseContext) => SqliteQuery,
): SqliteQuery {
  let aliasCount = 0;
  const nextAlias = (prefix: string) => `${prefix}_${aliasCount++}`;
  const deduplicate = options?.deduplicate ?? true;
  const subject: SqlSubject = {
    kind: "concrete",
    typeExpr: literalChunk(subjectRef.type),
    idExpr: literalChunk(subjectRef.id),
  };
  const context: ReverseContext = {
    model,
    namespace,
    nowMs,
    subject,
    forward: { model, namespace, nowMs, nextAlias },
    sccCteNames: new Map(),
    extraCtes: [],
    nextAlias,
    deduplicate,
  };
  const includeSubjectSets = modelHasSubjectSetTargets(model);
  const reachCte = subjectReachabilityCte({
    namespace,
    subjectKind: subjectRef.type,
    subjectId: subjectRef.id,
    nowMs,
    includeSubjectSets,
    columnRelations: model.columnRelations,
  });
  const allowedIds = compileBody(context);
  const allCtes = joinChunks([reachCte, ...context.extraCtes], ", ");
  const withKeyword =
    includeSubjectSets || context.extraCtes.length > 0
      ? "WITH RECURSIVE"
      : "WITH";
  const selectKeyword = deduplicate ? "SELECT DISTINCT" : "SELECT";
  const b = new QueryBuilder();
  return b.finish(
    `${withKeyword} ${b.append(allCtes)} ${selectKeyword} allowed_resource.resource_id FROM (${b.append(allowedIds)}) allowed_resource`,
  );
}

function compileReversePermission(
  context: ReverseContext,
  entity: string,
  permissionName: string,
): SqliteQuery {
  const key = permissionKey(entity, permissionName);
  const definition = context.model.permissionByKey.get(key);
  if (definition === undefined) {
    throw new Error(
      `SQLite policy cannot find permission ${entity}#${permissionName}`,
    );
  }
  const scc = context.model.cyclicSccsByKey.get(key);
  if (scc !== undefined) {
    const cteName = ensureReverseSccCte(context, scc, (childEntity, expr) =>
      compileReverseExpression(context, childEntity, expr),
    );
    const b = new QueryBuilder();
    return b.finish(
      `SELECT resource_id FROM ${cteName} WHERE entity = ${b.value(entity)} AND perm = ${b.value(permissionName)}`,
    );
  }
  return compileReverseExpression(context, entity, definition.expression);
}

function compileReverseExpression(
  context: ReverseContext,
  entity: string,
  expression: SqlitePermissionExpression,
): SqliteQuery {
  switch (expression.kind) {
    case "relation":
      return compileReverseRelation(entity, expression.relation);
    case "through":
      return compileReverseThrough(
        context,
        entity,
        expression.relation,
        expression.targets,
      );
    case "through-all":
      return compileReverseThroughAll(
        context,
        entity,
        expression.relation,
        expression.targets,
      );
    case "exclude":
      return compileReverseExclude(context, entity, expression);
    case "any-of":
    case "all-of":
      return compileReverseGroup(context, entity, expression);
  }
}

function compileReverseRelation(entity: string, relation: string): SqliteQuery {
  const b = new QueryBuilder();
  return b.finish(
    `SELECT sr.resource_id FROM subject_reachable sr WHERE sr.resource_kind = ${b.value(entity)} AND sr.relation = ${b.value(relation)}`,
  );
}

function compileReverseThrough(
  context: ReverseContext,
  entity: string,
  relation: string,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  const selectKeyword = context.deduplicate ? "SELECT DISTINCT" : "SELECT";
  const columnRel = findSqliteColumnRelation(context.model, entity, relation);
  const branches = targets.map((target) => {
    if (columnRel !== undefined) {
      if (columnRel.targetEntity !== target.entity) {
        return { sql: "SELECT '' AS resource_id WHERE 0", params: [] };
      }
      const edge = context.nextAlias("rev_thr");
      const related = compileReversePermission(
        context,
        target.entity,
        target.permission,
      );
      const b = new QueryBuilder();
      return b.finish(`${selectKeyword} ${edge}.${columnRel.idColumn} AS resource_id
        FROM (${b.append(related)}) rel_res
        CROSS JOIN ${columnRel.table} ${edge}
        WHERE ${edge}.${columnRel.targetIdColumn} = rel_res.resource_id
          AND ${edge}.${columnRel.targetIdColumn} IS NOT NULL`);
    }
    const edge = context.nextAlias("rev_thr");
    const related = compileReversePermission(
      context,
      target.entity,
      target.permission,
    );
    const b = new QueryBuilder();
    // CROSS JOIN pins `rel_res` as the outer loop in SQLite so the planner
    // always drives from the user's reached scopes via subject_lookup instead
    // of scanning every resource row when `rel_res` is empty or small.
    return b.finish(`${selectKeyword} ${edge}.resource_id
      FROM (${b.append(related)}) rel_res
      CROSS JOIN ${TUPLES} ${edge}
      WHERE ${edge}.namespace = ${b.value(context.namespace)}
        AND ${edge}.resource_kind = ${b.value(entity)}
        AND ${edge}.relation = ${b.value(relation)}
        AND ${edge}.subject_kind = ${b.value(target.entity)}
        AND ${edge}.subject_id = rel_res.resource_id
        AND ${edge}.subject_is_wildcard = 0
        AND ${edge}.subject_relation = ''
        AND ${activeTupleCondition(edge, b, context.nowMs)}`);
  });
  return joinChunks(branches, context.deduplicate ? " UNION " : " UNION ALL ");
}

function compileReverseThroughAll(
  context: ReverseContext,
  entity: string,
  relation: string,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  const candidates = compileReverseThrough(context, entity, relation, targets);
  const failAlias = context.nextAlias("rev_all");
  const columnRel = findSqliteColumnRelation(context.model, entity, relation);
  const b = new QueryBuilder();
  if (columnRel !== undefined) {
    const targetMatch = compileForwardColumnArrowTargets(
      context.forward,
      context.subject,
      columnRel.targetEntity,
      columnChunk(`${failAlias}.${columnRel.targetIdColumn}`),
      targets,
    );
    return b.finish(`SELECT DISTINCT cand.resource_id
      FROM (${b.append(candidates)}) cand
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${columnRel.table} ${failAlias}
        WHERE ${failAlias}.${columnRel.idColumn} = cand.resource_id
          AND ${failAlias}.${columnRel.targetIdColumn} IS NOT NULL
          AND NOT (${b.append(targetMatch)})
      )`);
  }
  const targetMatch = compileForwardArrowTargets(
    context.forward,
    context.subject,
    failAlias,
    targets,
  );
  return b.finish(`SELECT DISTINCT cand.resource_id
    FROM (${b.append(candidates)}) cand
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${TUPLES} ${failAlias}
      WHERE ${failAlias}.namespace = ${b.value(context.namespace)}
        AND ${failAlias}.resource_kind = ${b.value(entity)}
        AND ${failAlias}.resource_id = cand.resource_id
        AND ${failAlias}.relation = ${b.value(relation)}
        AND ${failAlias}.subject_is_wildcard = 0
        AND ${failAlias}.subject_relation = ''
        AND ${activeTupleCondition(failAlias, b, context.nowMs)}
        AND NOT (${b.append(targetMatch)})
    )`);
}

function compileReverseExclude(
  context: ReverseContext,
  entity: string,
  expression: Extract<SqlitePermissionExpression, { kind: "exclude" }>,
): SqliteQuery {
  const inc = compileReverseExpression(context, entity, expression.include);
  const exc = compileReverseExpression(context, entity, expression.exclude);
  const b = new QueryBuilder();
  return b.finish(
    `SELECT resource_id FROM (${b.append(inc)}) EXCEPT SELECT resource_id FROM (${b.append(exc)})`,
  );
}

function compileReverseGroup(
  context: ReverseContext,
  entity: string,
  expression: Extract<
    SqlitePermissionExpression,
    { kind: "any-of" | "all-of" }
  >,
): SqliteQuery {
  const operator =
    expression.kind === "any-of"
      ? context.deduplicate
        ? " UNION "
        : " UNION ALL "
      : " INTERSECT ";
  const branches = expression.expressions.map((child) => {
    const compiled = compileReverseExpression(context, entity, child);
    return {
      sql: `SELECT resource_id FROM (${compiled.sql})`,
      params: compiled.params,
    };
  });
  return joinChunks(branches, operator);
}
