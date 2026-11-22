import type { SqliteQuery } from "../sqlite-types.js";
import { findSqliteColumnRelation } from "./column-relations.js";
import {
  columnChunk,
  compileForwardGuards,
  literalChunk,
  type ForwardCompileContext,
  type SqlSubject,
} from "./compile-check.js";
import type {
  CompiledCyclicScc,
  RecursiveBaseClause,
  RecursiveStepClause,
  SqliteAuthorizationModel,
  SqlitePermissionExpression,
} from "./policy-model.js";
import {
  activeTupleCondition,
  joinChunks,
  QueryBuilder,
  TUPLES,
} from "./policy-sql.js";

export type ReverseSccContext = {
  readonly model: SqliteAuthorizationModel;
  readonly namespace: string;
  readonly nowMs: number;
  readonly subject: SqlSubject;
  readonly forward: ForwardCompileContext;
  readonly sccCteNames: Map<number, string>;
  readonly extraCtes: SqliteQuery[];
  readonly nextAlias: (prefix: string) => string;
};

export type CompileReverseExprFn = (
  entity: string,
  expression: SqlitePermissionExpression,
) => SqliteQuery;

/** Ensure a recursive reverse-lookup CTE exists for `scc` and return its CTE name. */
export function ensureReverseSccCte(
  context: ReverseSccContext,
  scc: CompiledCyclicScc,
  compileExpr: CompileReverseExprFn,
): string {
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
          compileReverseBaseClause(clause, compileExpr),
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
  clause: RecursiveBaseClause,
  compileExpr: CompileReverseExprFn,
): SqliteQuery {
  const ids = compileExpr(clause.entity, clause.expression);
  const b = new QueryBuilder();
  return b.finish(
    `SELECT ${b.value(clause.entity)} AS entity, base_res.resource_id AS resource_id, ${b.value(clause.permission)} AS perm FROM (${b.append(ids)}) base_res`,
  );
}

function compileReverseStepClause(
  context: ReverseSccContext,
  cteName: string,
  step: RecursiveStepClause,
): SqliteQuery {
  const edge = context.nextAlias("scc_edge");
  const columnRel = findSqliteColumnRelation(
    context.model,
    step.entity,
    step.relation,
  );
  if (columnRel !== undefined) {
    if (columnRel.targetEntity !== step.targetEntity) {
      return {
        sql: "SELECT '' AS entity, '' AS resource_id, '' AS perm WHERE 0",
        params: [],
      };
    }
    const guardSql = compileForwardGuards(
      context.forward,
      context.subject,
      {
        entity: step.entity,
        typeExpr: literalChunk(step.entity),
        idExpr: columnChunk(`${edge}.${columnRel.idColumn}`),
      },
      step.guards,
    );
    const b = new QueryBuilder();
    return b.finish(`SELECT ${b.value(step.entity)}, ${edge}.${columnRel.idColumn}, ${b.value(step.permission)}
      FROM ${cteName} prev
      CROSS JOIN ${columnRel.table} ${edge}
      WHERE ${edge}.${columnRel.targetIdColumn} = prev.resource_id
        AND ${edge}.${columnRel.targetIdColumn} IS NOT NULL
        AND prev.entity = ${b.value(step.targetEntity)}
        AND prev.perm = ${b.value(step.targetPermission)}${guardSql === undefined ? "" : ` AND (${b.append(guardSql)})`}`);
  }
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
    CROSS JOIN ${TUPLES} ${edge}
    WHERE ${edge}.namespace = ${b.value(context.namespace)}
      AND ${edge}.resource_kind = ${b.value(step.entity)}
      AND ${edge}.relation = ${b.value(step.relation)}
      AND ${edge}.subject_kind = prev.entity
      AND ${edge}.subject_id = prev.resource_id
      AND ${edge}.subject_is_wildcard = 0
      AND ${edge}.subject_relation = ''
      AND ${activeTupleCondition(edge, b, context.nowMs)}
      AND prev.entity = ${b.value(step.targetEntity)}
      AND prev.perm = ${b.value(step.targetPermission)}${guardSql === undefined ? "" : ` AND (${b.append(guardSql)})`}`);
}
