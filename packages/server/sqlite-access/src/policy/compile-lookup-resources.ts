import type { SqliteQuery } from "../sqlite-types.js";
import {
  columnChunk,
  compileForwardArrowTargets,
  compileForwardGuards,
  literalChunk,
  type ForwardCompileContext,
  type SqlSubject,
} from "./compile-check.js";
import {
  permissionKey,
  type SqliteAuthorizationModel,
  type SqliteArrowTarget,
  type CompiledCyclicScc,
  type SqlitePermissionExpression,
  type SqliteResourceLookup,
  type RecursiveBaseClause,
  type RecursiveStepClause,
} from "./policy-model.js";
import {
  activeTupleCondition,
  joinChunks,
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
): SqliteQuery {
  let aliasCount = 0;
  const nextAlias = (prefix: string) => `${prefix}_${aliasCount++}`;
  const subject: SqlSubject = {
    kind: "concrete",
    typeExpr: literalChunk(request.subject.type),
    idExpr: literalChunk(request.subject.id),
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
  };
  const reachCte = subjectReachabilityCte({
    namespace,
    subjectKind: request.subject.type,
    subjectId: request.subject.id,
    nowMs,
  });
  const allowedIds = compileReversePermission(
    context,
    request.resourceType,
    request.permission,
  );
  const allCtes = joinChunks([reachCte, ...context.extraCtes], ", ");
  const b = new QueryBuilder();
  return b.finish(
    `WITH RECURSIVE ${b.append(allCtes)} SELECT DISTINCT allowed_resource.resource_id FROM (${b.append(allowedIds)}) allowed_resource`,
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
    const cteName = ensureSccCte(context, scc);
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
  const branches = targets.map((target) => {
    const edge = context.nextAlias("rev_thr");
    const related = compileReversePermission(
      context,
      target.entity,
      target.permission,
    );
    const b = new QueryBuilder();
    return b.finish(`SELECT DISTINCT ${edge}.resource_id
      FROM (${b.append(related)}) rel_res
      JOIN ${TUPLES} ${edge}
        ON ${edge}.namespace = ${b.value(context.namespace)}
        AND ${edge}.resource_kind = ${b.value(entity)}
        AND ${edge}.relation = ${b.value(relation)}
        AND ${edge}.subject_kind = ${b.value(target.entity)}
        AND ${edge}.subject_id = rel_res.resource_id
        AND ${edge}.subject_is_wildcard = 0
        AND ${edge}.subject_relation = ''
        AND ${activeTupleCondition(edge, b, context.nowMs)}`);
  });
  return joinChunks(branches, " UNION ");
}

function compileReverseThroughAll(
  context: ReverseContext,
  entity: string,
  relation: string,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  const candidates = compileReverseThrough(context, entity, relation, targets);
  const failAlias = context.nextAlias("rev_all");
  const targetMatch = compileForwardArrowTargets(
    context.forward,
    context.subject,
    failAlias,
    targets,
  );
  const b = new QueryBuilder();
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
  const operator = expression.kind === "any-of" ? " UNION " : " INTERSECT ";
  const branches = expression.expressions.map((child) => {
    const compiled = compileReverseExpression(context, entity, child);
    return {
      sql: `SELECT resource_id FROM (${compiled.sql})`,
      params: compiled.params,
    };
  });
  return joinChunks(branches, operator);
}

function ensureSccCte(context: ReverseContext, scc: CompiledCyclicScc): string {
  const existing = context.sccCteNames.get(scc.id);
  if (existing !== undefined) return existing;
  const cteName = `scc_allowed_${scc.id}`;
  context.sccCteNames.set(scc.id, cteName);

  const baseBranches =
    scc.baseClauses.length === 0
      ? [
          {
            sql: "SELECT '' AS entity, '' AS resource_id, '' AS perm WHERE 0",
            params: [],
          },
        ]
      : scc.baseClauses.map((clause) =>
          compileReverseBaseClause(context, clause),
        );
  const stepBranches = scc.stepClauses.map((step) =>
    compileReverseStepClause(context, cteName, step),
  );
  const anchorChunk = joinChunks(baseBranches, " UNION ");
  const stepsChunk = joinChunks(stepBranches, " UNION ");
  const b = new QueryBuilder();
  const cte = b.finish(
    `${cteName}(entity, resource_id, perm) AS (${b.append(anchorChunk)}${stepBranches.length > 0 ? ` UNION ${b.append(stepsChunk)}` : ""})`,
  );
  context.extraCtes.push(cte);
  return cteName;
}

function compileReverseBaseClause(
  context: ReverseContext,
  clause: RecursiveBaseClause,
): SqliteQuery {
  const ids = compileReverseExpression(
    context,
    clause.entity,
    clause.expression,
  );
  const b = new QueryBuilder();
  return b.finish(
    `SELECT ${b.value(clause.entity)} AS entity, base_res.resource_id AS resource_id, ${b.value(clause.permission)} AS perm FROM (${b.append(ids)}) base_res`,
  );
}

function compileReverseStepClause(
  context: ReverseContext,
  cteName: string,
  step: RecursiveStepClause,
): SqliteQuery {
  const edge = context.nextAlias("scc_edge");
  const guardSql = compileForwardGuards(
    context.forward,
    context.subject,
    {
      entity: step.entity,
      typeExpr: literalChunk(step.entity),
      idExpr: columnChunk(`${edge}.resource_id`),
    },
    step.guards,
  );
  const b = new QueryBuilder();
  return b.finish(`SELECT ${b.value(step.entity)}, ${edge}.resource_id, ${b.value(step.permission)}
    FROM ${cteName} prev
    JOIN ${TUPLES} ${edge}
      ON ${edge}.namespace = ${b.value(context.namespace)}
      AND ${edge}.resource_kind = ${b.value(step.entity)}
      AND ${edge}.relation = ${b.value(step.relation)}
      AND ${edge}.subject_kind = prev.entity
      AND ${edge}.subject_id = prev.resource_id
      AND ${edge}.subject_is_wildcard = 0
      AND ${edge}.subject_relation = ''
      AND ${activeTupleCondition(edge, b, context.nowMs)}
    WHERE prev.entity = ${b.value(step.targetEntity)}
      AND prev.perm = ${b.value(step.targetPermission)}${guardSql === undefined ? "" : ` AND (${b.append(guardSql)})`}`);
}
