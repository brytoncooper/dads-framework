import type { SqliteQuery } from "../sqlite-types.js";
import { findSqliteColumnRelation } from "./column-relations.js";
import {
  columnChunk,
  compileArrowTargetDisjunction,
  compileColumnArrowTargets,
  type ForwardCompileContext,
  type ForwardPermissionCompiler,
  type SqlResource,
  type SqlSubject,
} from "./compile-forward-scc.js";
import type { SqliteArrowTarget } from "./policy-model.js";
import { activeTupleCondition, QueryBuilder, TUPLES } from "./policy-sql.js";

/** Compile a forward `through` arrow predicate against either a column relation or the tuple table. */
export function compileSqliteThrough(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
  targets: readonly SqliteArrowTarget[],
  compilePermission: ForwardPermissionCompiler,
): SqliteQuery {
  const alias = context.nextAlias("thr");
  const columnRel = findSqliteColumnRelation(
    context.model,
    resource.entity,
    relation,
  );
  const b = new QueryBuilder();
  if (columnRel !== undefined) {
    const targetMatch = compileColumnArrowTargets(
      context,
      subject,
      columnRel.targetEntity,
      columnChunk(`${alias}.${columnRel.targetIdColumn}`),
      targets,
      compilePermission,
    );
    return b.finish(`EXISTS (
      SELECT 1
      FROM ${columnRel.table} ${alias}
      WHERE ${b.append(resource.typeExpr)} = ${b.value(columnRel.entity)}
        AND ${alias}.${columnRel.idColumn} = ${b.append(resource.idExpr)}
        AND ${alias}.${columnRel.targetIdColumn} IS NOT NULL
        AND (${b.append(targetMatch)})
    )`);
  }
  const targetMatch = compileArrowTargetDisjunction(
    context,
    subject,
    alias,
    targets,
    compilePermission,
  );
  return b.finish(`EXISTS (
    SELECT 1
    FROM ${TUPLES} ${alias}
    WHERE ${alias}.namespace = ${b.value(context.namespace)}
      AND ${alias}.resource_kind = ${b.append(resource.typeExpr)}
      AND ${alias}.resource_id = ${b.append(resource.idExpr)}
      AND ${alias}.relation = ${b.value(relation)}
      AND ${alias}.subject_is_wildcard = 0
      AND ${alias}.subject_relation = ''
      AND ${activeTupleCondition(alias, b, context.nowMs)}
      AND (${b.append(targetMatch)})
  )`);
}

/** Compile a forward `through-all` (`every()`) arrow predicate against a column relation or tuple table. */
export function compileSqliteThroughAll(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
  targets: readonly SqliteArrowTarget[],
  compilePermission: ForwardPermissionCompiler,
): SqliteQuery {
  const existsAlias = context.nextAlias("all_e");
  const failAlias = context.nextAlias("all_n");
  const columnRel = findSqliteColumnRelation(
    context.model,
    resource.entity,
    relation,
  );
  const b = new QueryBuilder();
  if (columnRel !== undefined) {
    const targetMatch = compileColumnArrowTargets(
      context,
      subject,
      columnRel.targetEntity,
      columnChunk(`${failAlias}.${columnRel.targetIdColumn}`),
      targets,
      compilePermission,
    );
    return b.finish(`(
      EXISTS (
        SELECT 1
        FROM ${columnRel.table} ${existsAlias}
        WHERE ${b.append(resource.typeExpr)} = ${b.value(columnRel.entity)}
          AND ${existsAlias}.${columnRel.idColumn} = ${b.append(resource.idExpr)}
          AND ${existsAlias}.${columnRel.targetIdColumn} IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${columnRel.table} ${failAlias}
        WHERE ${b.append(resource.typeExpr)} = ${b.value(columnRel.entity)}
          AND ${failAlias}.${columnRel.idColumn} = ${b.append(resource.idExpr)}
          AND ${failAlias}.${columnRel.targetIdColumn} IS NOT NULL
          AND NOT (${b.append(targetMatch)})
      )
    )`);
  }
  const targetMatch = compileArrowTargetDisjunction(
    context,
    subject,
    failAlias,
    targets,
    compilePermission,
  );
  return b.finish(`(
    EXISTS (
      SELECT 1
      FROM ${TUPLES} ${existsAlias}
      WHERE ${existsAlias}.namespace = ${b.value(context.namespace)}
        AND ${existsAlias}.resource_kind = ${b.append(resource.typeExpr)}
        AND ${existsAlias}.resource_id = ${b.append(resource.idExpr)}
        AND ${existsAlias}.relation = ${b.value(relation)}
        AND ${existsAlias}.subject_is_wildcard = 0
        AND ${existsAlias}.subject_relation = ''
        AND ${activeTupleCondition(existsAlias, b, context.nowMs)}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${TUPLES} ${failAlias}
      WHERE ${failAlias}.namespace = ${b.value(context.namespace)}
        AND ${failAlias}.resource_kind = ${b.append(resource.typeExpr)}
        AND ${failAlias}.resource_id = ${b.append(resource.idExpr)}
        AND ${failAlias}.relation = ${b.value(relation)}
        AND ${failAlias}.subject_is_wildcard = 0
        AND ${failAlias}.subject_relation = ''
        AND ${activeTupleCondition(failAlias, b, context.nowMs)}
        AND NOT (${b.append(targetMatch)})
    )
  )`);
}
