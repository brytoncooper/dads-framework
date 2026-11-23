import { SQLITE_RELATIONSHIP_TABLE } from "../sqlite-schema.js";
import type { SqliteQuery, SqliteValue } from "../sqlite-types.js";
import type { CompiledSqliteColumnRelation, SqliteAuthorizationModel } from "./policy-model.js";

/** The single relationship table every compiled SQLite statement reads. */
export const TUPLES = SQLITE_RELATIONSHIP_TABLE;

/** Positional SQLite query builder emitting `?` placeholders in strict left-to-right order. */
export class QueryBuilder {
  readonly values: SqliteValue[] = [];
  #aliasCount = 0;

  value(value: SqliteValue): string {
    this.values.push(value);
    return "?";
  }

  append(chunk: SqliteQuery): string {
    this.values.push(...chunk.params);
    return chunk.sql;
  }

  alias(prefix: string): string {
    const name = `${prefix}_${this.#aliasCount}`;
    this.#aliasCount += 1;
    return name;
  }

  finish(sql: string): SqliteQuery {
    return Object.freeze({ sql, params: [...this.values] });
  }
}

/** Combine an array of SQL chunks with a separator while keeping `?` parameters aligned. */
export function joinChunks(chunks: readonly SqliteQuery[], separator: string): SqliteQuery {
  const sqlParts: string[] = [];
  const params: SqliteValue[] = [];
  for (const chunk of chunks) {
    sqlParts.push(chunk.sql);
    params.push(...chunk.params);
  }
  return { sql: sqlParts.join(separator), params };
}

/** SQL condition asserting a tuple row is active at `nowMs`. */
export function activeTupleCondition(alias: string, builder: QueryBuilder, nowMs: number): string {
  return `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ${builder.value(nowMs)})`;
}

/** True when any relation in the SQLite model accepts a `subject-set` (`group#member`) target. */
export function modelHasSubjectSetTargets(model: SqliteAuthorizationModel): boolean {
  return model.relations.some((relation) => relation.targets.some((target) => target.kind === "subject-set"));
}

/**
 * CTE finding every `(resource_kind, resource_id, relation)` reachable from a
 * concrete subject. Omits the recursive userset step when `includeSubjectSets`
 * is `false` so SQLite avoids recursive worktable overhead.
 */
export function subjectReachabilityCte(options: {
  readonly namespace: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly nowMs: number;
  readonly includeSubjectSets?: boolean;
  readonly columnRelations?: readonly CompiledSqliteColumnRelation[] | undefined;
}): SqliteQuery {
  const b = new QueryBuilder();
  const directSql = `SELECT dt.resource_kind, dt.resource_id, dt.relation
    FROM ${TUPLES} dt
    WHERE dt.namespace = ${b.value(options.namespace)}
      AND dt.subject_kind = ${b.value(options.subjectKind)}
      AND dt.subject_id = ${b.value(options.subjectId)}
      AND dt.subject_is_wildcard = 0
      AND dt.subject_relation = ''
      AND ${activeTupleCondition("dt", b, options.nowMs)}`;
  const wildcardSql = `SELECT wt.resource_kind, wt.resource_id, wt.relation
    FROM ${TUPLES} wt
    WHERE wt.namespace = ${b.value(options.namespace)}
      AND wt.subject_kind = ${b.value(options.subjectKind)}
      AND wt.subject_id = ''
      AND wt.subject_is_wildcard = 1
      AND wt.subject_relation = ''
      AND ${activeTupleCondition("wt", b, options.nowMs)}`;
  const columnParts = (options.columnRelations ?? [])
    .filter((columnRel) => columnRel.targetEntity === options.subjectKind)
    .map(
      (
        columnRel,
      ) => `SELECT ${b.value(columnRel.entity)} AS resource_kind, col_rel.${columnRel.idColumn} AS resource_id, ${b.value(columnRel.relation)} AS relation
      FROM ${columnRel.table} col_rel
      WHERE col_rel.${columnRel.targetIdColumn} = ${b.value(options.subjectId)}
        AND col_rel.${columnRel.targetIdColumn} IS NOT NULL`,
    );
  const baseParts = [directSql, wildcardSql, ...columnParts];
  if (options.includeSubjectSets === false) {
    return b.finish(`subject_reachable(resource_kind, resource_id, relation) AS (${baseParts.join(" UNION ALL ")})`);
  }
  const stepSql = `SELECT pt.resource_kind, pt.resource_id, pt.relation
    FROM subject_reachable sr
    CROSS JOIN ${TUPLES} pt
    WHERE pt.namespace = ${b.value(options.namespace)}
      AND pt.subject_kind = sr.resource_kind
      AND pt.subject_id = sr.resource_id
      AND pt.subject_relation = sr.relation
      AND pt.subject_is_wildcard = 0
      AND pt.subject_relation <> ''
      AND ${activeTupleCondition("pt", b, options.nowMs)}`;
  return b.finish(
    `subject_reachable(resource_kind, resource_id, relation) AS (${[...baseParts, stepSql].join(" UNION ")})`,
  );
}
