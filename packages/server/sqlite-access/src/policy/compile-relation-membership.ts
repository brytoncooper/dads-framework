import type { SqliteQuery } from "../sqlite-types.js";
import { findSqliteColumnRelation } from "./column-relations.js";
import type {
  ForwardCompileContext,
  SqlResource,
  SqlSubject,
} from "./compile-forward-scc.js";
import {
  activeTupleCondition,
  joinChunks,
  QueryBuilder,
  TUPLES,
} from "./policy-sql.js";

/**
 * Compiles a SQLite membership check for one `(resource, relation, subject)`
 * tuple. Uses a direct primary-key `EXISTS` lookup when the relation declares
 * no `subject-set` targets, and falls back to recursive userset expansion
 * otherwise.
 */
export function compileRelationMembership(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
): SqliteQuery {
  const columnRel = findSqliteColumnRelation(
    context.model,
    resource.entity,
    relation,
  );
  if (columnRel !== undefined) {
    if (subject.kind === "wildcard-only") {
      return { sql: "0", params: [] };
    }
    const b = new QueryBuilder();
    const alias = context.nextAlias("col");
    return b.finish(`EXISTS (
      SELECT 1 FROM ${columnRel.table} ${alias}
      WHERE ${b.append(resource.typeExpr)} = ${b.value(columnRel.entity)}
        AND ${alias}.${columnRel.idColumn} = ${b.append(resource.idExpr)}
        AND ${b.append(subject.typeExpr)} = ${b.value(columnRel.targetEntity)}
        AND ${alias}.${columnRel.targetIdColumn} = ${b.append(subject.idExpr)}
        AND ${alias}.${columnRel.targetIdColumn} IS NOT NULL
    )`);
  }
  const relDef = context.model.relations.find(
    (candidate) =>
      candidate.entity === resource.entity && candidate.wireName === relation,
  );
  const allowsUsersets =
    relDef === undefined ||
    relDef.targets.some((target) => target.kind === "subject-set");
  const allowsWildcards =
    relDef === undefined ||
    relDef.targets.some((target) => target.kind === "wildcard");

  if (!allowsUsersets) {
    return compileDirectRelationMembership(
      context,
      subject,
      resource,
      relation,
      allowsWildcards,
    );
  }

  const b = new QueryBuilder();
  const cte = context.nextAlias("req");
  const subjectMatch = compileSubjectMatch(subject);
  return b.finish(`EXISTS (
    WITH RECURSIVE ${cte}(resource_kind, resource_id, relation) AS (
      SELECT ${b.append(resource.typeExpr)}, ${b.append(resource.idExpr)}, ${b.value(relation)}
      UNION
      SELECT t.subject_kind, t.subject_id, t.subject_relation
      FROM ${cte} r
      JOIN ${TUPLES} t
        ON t.namespace = ${b.value(context.namespace)}
        AND t.resource_kind = r.resource_kind
        AND t.resource_id = r.resource_id
        AND t.relation = r.relation
        AND t.subject_is_wildcard = 0
        AND t.subject_relation <> ''
        AND ${activeTupleCondition("t", b, context.nowMs)}
    )
    SELECT 1
    FROM ${cte} r
    JOIN ${TUPLES} m
      ON m.namespace = ${b.value(context.namespace)}
      AND m.resource_kind = r.resource_kind
      AND m.resource_id = r.resource_id
      AND m.relation = r.relation
      AND ${activeTupleCondition("m", b, context.nowMs)}
    WHERE ${b.append(subjectMatch)}
    LIMIT 1
  )`);
}

function compileDirectRelationMembership(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
  allowsWildcards: boolean,
): SqliteQuery {
  const b = new QueryBuilder();
  if (subject.kind === "wildcard-only") {
    if (!allowsWildcards) return { sql: "0", params: [] };
    return b.finish(`EXISTS (
      SELECT 1 FROM ${TUPLES} m
      WHERE m.namespace = ${b.value(context.namespace)}
        AND m.resource_kind = ${b.append(resource.typeExpr)}
        AND m.resource_id = ${b.append(resource.idExpr)}
        AND m.relation = ${b.value(relation)}
        AND m.subject_kind = ${b.append(subject.typeExpr)}
        AND m.subject_id = ''
        AND m.subject_relation = ''
        AND m.subject_is_wildcard = 1
        AND ${activeTupleCondition("m", b, context.nowMs)}
    )`);
  }
  const direct = b.finish(`EXISTS (
    SELECT 1 FROM ${TUPLES} m
    WHERE m.namespace = ${b.value(context.namespace)}
      AND m.resource_kind = ${b.append(resource.typeExpr)}
      AND m.resource_id = ${b.append(resource.idExpr)}
      AND m.relation = ${b.value(relation)}
      AND m.subject_kind = ${b.append(subject.typeExpr)}
      AND m.subject_id = ${b.append(subject.idExpr)}
      AND m.subject_relation = ''
      AND m.subject_is_wildcard = 0
      AND ${activeTupleCondition("m", b, context.nowMs)}
  )`);
  if (!allowsWildcards) return direct;
  const wb = new QueryBuilder();
  const wildcard = wb.finish(`EXISTS (
    SELECT 1 FROM ${TUPLES} m
    WHERE m.namespace = ${wb.value(context.namespace)}
      AND m.resource_kind = ${wb.append(resource.typeExpr)}
      AND m.resource_id = ${wb.append(resource.idExpr)}
      AND m.relation = ${wb.value(relation)}
      AND m.subject_kind = ${wb.append(subject.typeExpr)}
      AND m.subject_id = ''
      AND m.subject_relation = ''
      AND m.subject_is_wildcard = 1
      AND ${activeTupleCondition("m", wb, context.nowMs)}
  )`);
  return joinChunks([direct, wildcard], " OR ");
}

function compileSubjectMatch(subject: SqlSubject): SqliteQuery {
  const b = new QueryBuilder();
  if (subject.kind === "wildcard-only") {
    return b.finish(
      `(m.subject_is_wildcard = 1 AND m.subject_kind = ${b.append(subject.typeExpr)})`,
    );
  }
  return b.finish(
    `((m.subject_is_wildcard = 0 AND m.subject_relation = '' AND m.subject_kind = ${b.append(subject.typeExpr)} AND m.subject_id = ${b.append(subject.idExpr)}) OR (m.subject_is_wildcard = 1 AND m.subject_kind = ${b.append(subject.typeExpr)}))`,
  );
}
