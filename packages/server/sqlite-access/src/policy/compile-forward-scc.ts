import type { SqliteQuery } from "../sqlite-types.js";
import { findSqliteColumnRelation } from "./column-relations.js";
import type {
  SqliteAuthorizationModel,
  SqliteArrowTarget,
  CompiledCyclicScc,
  SqlitePermissionExpression,
  GuardCondition,
  RecursiveBaseClause,
  RecursiveStepClause,
} from "./policy-model.js";
import {
  activeTupleCondition,
  joinChunks,
  QueryBuilder,
  TUPLES,
} from "./policy-sql.js";

export type SqlSubject =
  | {
      readonly kind: "concrete";
      readonly typeExpr: SqliteQuery;
      readonly idExpr: SqliteQuery;
    }
  | {
      readonly kind: "wildcard-only";
      readonly typeExpr: SqliteQuery;
    };

export type SqlResource = {
  readonly entity: string;
  readonly typeExpr: SqliteQuery;
  readonly idExpr: SqliteQuery;
};

export type ForwardCompileContext = {
  readonly model: SqliteAuthorizationModel;
  readonly namespace: string;
  readonly nowMs: number;
  readonly nextAlias: (prefix: string) => string;
};

export type ForwardExpressionCompiler = (
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  expression: SqlitePermissionExpression,
) => SqliteQuery;

export type ForwardPermissionCompiler = (
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  permissionName: string,
) => SqliteQuery;

/** Wrap a literal SQLite value as a single-placeholder SQL chunk. */
export function literalChunk(value: string): SqliteQuery {
  return { sql: "?", params: [value] };
}

/** Wrap a SQL column identifier as a zero-parameter SQL chunk. */
export function columnChunk(identifier: string): SqliteQuery {
  return { sql: identifier, params: [] };
}

/** Disjunction matching a tuple row's `(subject_kind, subject_id)` against arrow targets. */
export function compileArrowTargetDisjunction(
  context: ForwardCompileContext,
  subject: SqlSubject,
  tupleAlias: string,
  targets: readonly SqliteArrowTarget[],
  compilePermission: ForwardPermissionCompiler,
): SqliteQuery {
  const branches = targets.map((target) => {
    const b = new QueryBuilder();
    const targetResource: SqlResource = {
      entity: target.entity,
      typeExpr: columnChunk(`${tupleAlias}.subject_kind`),
      idExpr: columnChunk(`${tupleAlias}.subject_id`),
    };
    const child = compilePermission(
      context,
      subject,
      targetResource,
      target.permission,
    );
    return b.finish(
      `(${tupleAlias}.subject_kind = ${b.value(target.entity)} AND (${b.append(child)}))`,
    );
  });
  return joinChunks(branches, " OR ");
}

/** Disjunction matching a column-backed target `(targetEntity, targetIdExpr)` against arrow targets. */
export function compileColumnArrowTargets(
  context: ForwardCompileContext,
  subject: SqlSubject,
  targetEntity: string,
  targetIdExpr: SqliteQuery,
  targets: readonly SqliteArrowTarget[],
  compilePermission: ForwardPermissionCompiler,
): SqliteQuery {
  const matching = targets.filter((target) => target.entity === targetEntity);
  if (matching.length === 0) return { sql: "0", params: [] };
  const branches = matching.map((target) =>
    compilePermission(
      context,
      subject,
      {
        entity: target.entity,
        typeExpr: literalChunk(target.entity),
        idExpr: targetIdExpr,
      },
      target.permission,
    ),
  );
  return joinChunks(branches, " OR ");
}

/** Compile a forward recursive walk over a monotonic cyclic SCC. */
export function compileForwardCyclicScc(
  context: ForwardCompileContext,
  scc: CompiledCyclicScc,
  subject: SqlSubject,
  resource: SqlResource,
  permissionName: string,
  compileExpression: ForwardExpressionCompiler,
): SqliteQuery {
  if (scc.baseClauses.length === 0) return { sql: "0", params: [] };
  const walkAlias = context.nextAlias("walk");
  const stepChunks = scc.stepClauses.map((step) =>
    compileForwardStepClause(
      context,
      walkAlias,
      subject,
      step,
      compileExpression,
    ),
  );
  const baseChunks = scc.baseClauses.map((clause) =>
    compileForwardBaseClause(context, subject, clause, compileExpression),
  );
  const stepsSql = joinChunks(stepChunks, " UNION ");
  const basesSql = joinChunks(baseChunks, " OR ");
  const b = new QueryBuilder();
  return b.finish(`EXISTS (
    WITH RECURSIVE ${walkAlias}(entity, resource_id, perm) AS (
      SELECT ${b.append(resource.typeExpr)}, ${b.append(resource.idExpr)}, ${b.value(permissionName)}
      ${stepChunks.length > 0 ? `UNION ${b.append(stepsSql)}` : ""}
    )
    SELECT 1
    FROM ${walkAlias} w
    WHERE ${b.append(basesSql)}
    LIMIT 1
  )`);
}

function compileForwardStepClause(
  context: ForwardCompileContext,
  walkAlias: string,
  subject: SqlSubject,
  step: RecursiveStepClause,
  compileExpression: ForwardExpressionCompiler,
): SqliteQuery {
  const edge = context.nextAlias("edge");
  const guardSql = compileGuardConditions(
    context,
    subject,
    {
      entity: step.entity,
      typeExpr: columnChunk("w.entity"),
      idExpr: columnChunk("w.resource_id"),
    },
    step.guards,
    compileExpression,
  );
  const columnRel = findSqliteColumnRelation(
    context.model,
    step.entity,
    step.relation,
  );
  const b = new QueryBuilder();
  if (columnRel !== undefined) {
    if (columnRel.targetEntity !== step.targetEntity) {
      return {
        sql: "SELECT '' AS entity, '' AS resource_id, '' AS perm WHERE 0",
        params: [],
      };
    }
    return b.finish(`SELECT ${b.value(step.targetEntity)}, ${edge}.${columnRel.targetIdColumn}, ${b.value(step.targetPermission)}
      FROM ${walkAlias} w
      JOIN ${columnRel.table} ${edge}
        ON ${edge}.${columnRel.idColumn} = w.resource_id
        AND ${edge}.${columnRel.targetIdColumn} IS NOT NULL
      WHERE w.entity = ${b.value(step.entity)}
        AND w.perm = ${b.value(step.permission)}${guardSql === undefined ? "" : ` AND (${b.append(guardSql)})`}`);
  }
  return b.finish(`SELECT ${b.value(step.targetEntity)}, ${edge}.subject_id, ${b.value(step.targetPermission)}
    FROM ${walkAlias} w
    JOIN ${TUPLES} ${edge}
      ON ${edge}.namespace = ${b.value(context.namespace)}
      AND ${edge}.resource_kind = w.entity
      AND ${edge}.resource_id = w.resource_id
      AND ${edge}.relation = ${b.value(step.relation)}
      AND ${edge}.subject_kind = ${b.value(step.targetEntity)}
      AND ${edge}.subject_is_wildcard = 0
      AND ${edge}.subject_relation = ''
      AND ${activeTupleCondition(edge, b, context.nowMs)}
    WHERE w.entity = ${b.value(step.entity)}
      AND w.perm = ${b.value(step.permission)}${guardSql === undefined ? "" : ` AND (${b.append(guardSql)})`}`);
}

function compileForwardBaseClause(
  context: ForwardCompileContext,
  subject: SqlSubject,
  clause: RecursiveBaseClause,
  compileExpression: ForwardExpressionCompiler,
): SqliteQuery {
  const predicate = compileExpression(
    context,
    subject,
    {
      entity: clause.entity,
      typeExpr: columnChunk("w.entity"),
      idExpr: columnChunk("w.resource_id"),
    },
    clause.expression,
  );
  const b = new QueryBuilder();
  return b.finish(
    `(w.entity = ${b.value(clause.entity)} AND w.perm = ${b.value(clause.permission)} AND (${b.append(predicate)}))`,
  );
}

/** Compile external guard conditions attached to a recursive step clause. */
export function compileGuardConditions(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  guards: readonly GuardCondition[],
  compileExpression: ForwardExpressionCompiler,
): SqliteQuery | undefined {
  if (guards.length === 0) return undefined;
  const parts = guards.map((guard) => {
    const compiled = compileExpression(
      context,
      subject,
      resource,
      guard.expression,
    );
    return guard.positive
      ? { sql: `(${compiled.sql})`, params: compiled.params }
      : { sql: `NOT (${compiled.sql})`, params: compiled.params };
  });
  return joinChunks(parts, " AND ");
}
