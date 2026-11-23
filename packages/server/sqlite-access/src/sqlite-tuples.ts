import type {
  DirectSubjectLookup,
  RelationshipFilter,
  RelationshipWrite,
  SubjectRef,
} from "@dads-framework/access/runtime";

import { findSqliteColumnRelation } from "./policy/column-relations.js";
import type {
  CompiledSqliteColumnRelation,
  SqliteAuthorizationModel,
  SqliteRelationTarget,
} from "./policy/policy-model.js";
import { activeTupleCondition, QueryBuilder, TUPLES } from "./policy/policy-sql.js";
import type { SqliteExecutor } from "./sqlite-executor.js";
import { readStringColumn } from "./sqlite-types.js";

type ExactFilter = Required<Pick<RelationshipFilter, "resourceType" | "resourceId" | "relation">>;

const UPSERT_SQL = `INSERT INTO ${TUPLES} (
  namespace, resource_kind, resource_id, relation,
  subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (
  namespace, resource_kind, resource_id, relation,
  subject_kind, subject_id, subject_relation, subject_is_wildcard
) DO UPDATE SET expires_at = excluded.expires_at`;

const REMOVE_SQL = `DELETE FROM ${TUPLES}
WHERE namespace = ? AND resource_kind = ? AND resource_id = ? AND relation = ?
  AND subject_kind = ? AND subject_id = ? AND subject_relation = ? AND subject_is_wildcard = ?`;

export class SqliteTuples {
  readonly #model: SqliteAuthorizationModel;
  readonly #namespace: string;
  readonly #executor: SqliteExecutor;

  constructor(model: SqliteAuthorizationModel, namespace: string, executor: SqliteExecutor) {
    this.#model = model;
    this.#namespace = namespace;
    this.#executor = executor;
  }

  async write(writes: readonly RelationshipWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const validated = writes.map((write) => this.#validateWrite(write));
    for (const entry of validated) {
      await this.#executor.run(UPSERT_SQL, [
        this.#namespace,
        entry.resource.type,
        entry.resource.id,
        entry.relation,
        entry.subject.type,
        entry.subject.id === "*" ? "" : entry.subject.id,
        entry.subject.relation ?? "",
        entry.subject.id === "*" ? 1 : 0,
        encodeExpiresAt(entry.expiresAt),
      ]);
    }
  }

  async remove(write: RelationshipWrite): Promise<void> {
    const entry = this.#validateWrite(write);
    await this.#executor.run(REMOVE_SQL, [
      this.#namespace,
      entry.resource.type,
      entry.resource.id,
      entry.relation,
      entry.subject.type,
      entry.subject.id === "*" ? "" : entry.subject.id,
      entry.subject.relation ?? "",
      entry.subject.id === "*" ? 1 : 0,
    ]);
  }

  async delete(filter: RelationshipFilter): Promise<void> {
    if (filter.resourceType === "") {
      throw new Error("SQLite authorization requires a resource type");
    }
    if (filter.relation !== undefined && filter.relation !== "") {
      const columnRel = findSqliteColumnRelation(this.#model, filter.resourceType, filter.relation);
      if (columnRel !== undefined) {
        throw sqliteColumnMutationError(columnRel);
      }
    }
    const b = new QueryBuilder();
    const clauses = [`namespace = ${b.value(this.#namespace)}`, `resource_kind = ${b.value(filter.resourceType)}`];
    appendDeleteResourceClauses(clauses, b, filter);
    appendDeleteSubjectClauses(clauses, b, filter.subject);
    const query = b.finish(`DELETE FROM ${TUPLES} WHERE ${clauses.join(" AND ")}`);
    await this.#executor.run(query.sql, query.params);
  }

  async exists(filter: ExactFilter, nowMs: number): Promise<boolean> {
    requireExact(filter.resourceType, filter.resourceId, filter.relation);
    const columnRel = findSqliteColumnRelation(this.#model, filter.resourceType, filter.relation);
    if (columnRel !== undefined) {
      const rows = await this.#executor.all(
        `SELECT 1 AS present FROM ${columnRel.table} WHERE ${columnRel.idColumn} = ? AND ${columnRel.targetIdColumn} IS NOT NULL LIMIT 1`,
        [filter.resourceId],
      );
      return rows.length > 0;
    }
    const b = new QueryBuilder();
    const query = b.finish(
      `SELECT 1 AS present FROM ${TUPLES} t WHERE t.namespace = ${b.value(this.#namespace)} AND t.resource_kind = ${b.value(filter.resourceType)} AND t.resource_id = ${b.value(filter.resourceId)} AND t.relation = ${b.value(filter.relation)} AND ${activeTupleCondition("t", b, nowMs)} LIMIT 1`,
    );
    const rows = await this.#executor.all(query.sql, query.params);
    return rows.length > 0;
  }

  async list(query: DirectSubjectLookup, nowMs: number): Promise<readonly SubjectRef[]> {
    requireExact(query.resource.type, query.resource.id, query.relation);
    const columnRel = findSqliteColumnRelation(this.#model, query.resource.type, query.relation);
    if (columnRel !== undefined) {
      const rows = await this.#executor.all(
        `SELECT DISTINCT ${columnRel.targetIdColumn} AS subject_id FROM ${columnRel.table} WHERE ${columnRel.idColumn} = ? AND ${columnRel.targetIdColumn} IS NOT NULL ORDER BY ${columnRel.targetIdColumn}`,
        [query.resource.id],
      );
      return rows.map((row) => ({
        type: columnRel.targetEntity,
        id: readStringColumn(row, "subject_id"),
      }));
    }
    const b = new QueryBuilder();
    const compiled = b.finish(
      `SELECT t.subject_kind, CASE WHEN t.subject_is_wildcard = 1 THEN '*' ELSE t.subject_id END AS subject_id, t.subject_relation FROM ${TUPLES} t WHERE t.namespace = ${b.value(this.#namespace)} AND t.resource_kind = ${b.value(query.resource.type)} AND t.resource_id = ${b.value(query.resource.id)} AND t.relation = ${b.value(query.relation)} AND ${activeTupleCondition("t", b, nowMs)} ORDER BY t.subject_kind, subject_id, t.subject_relation`,
    );
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    return rows.map((row) => {
      const relation = readStringColumn(row, "subject_relation");
      return {
        type: readStringColumn(row, "subject_kind"),
        id: readStringColumn(row, "subject_id"),
        ...(relation === "" ? {} : { relation }),
      };
    });
  }

  #validateWrite(write: RelationshipWrite): RelationshipWrite {
    const columnRel = findSqliteColumnRelation(this.#model, write.resource.type, write.relation);
    if (columnRel !== undefined) {
      throw sqliteColumnMutationError(columnRel);
    }
    const relation = this.#model.relations.find(
      (entry) => entry.entity === write.resource.type && entry.wireName === write.relation,
    );
    if (relation === undefined || !relation.targets.some((target) => matchesTarget(target, write.subject))) {
      throw new Error(`Invalid authorization relationship ${write.resource.type}#${write.relation}`);
    }
    if (write.resource.id === "" || write.resource.id === "*" || write.subject.id === "") {
      throw new Error("An authorization relationship requires resource and subject identifiers");
    }
    encodeExpiresAt(write.expiresAt);
    return write;
  }
}

function appendDeleteResourceClauses(clauses: string[], b: QueryBuilder, filter: RelationshipFilter): void {
  if (filter.resourceId !== undefined && filter.resourceId !== "") {
    clauses.push(`resource_id = ${b.value(filter.resourceId)}`);
  }
  if (filter.relation !== undefined && filter.relation !== "") {
    clauses.push(`relation = ${b.value(filter.relation)}`);
  }
}

function appendDeleteSubjectClauses(clauses: string[], b: QueryBuilder, subject: SubjectRef | undefined): void {
  if (subject === undefined) return;
  clauses.push(`subject_kind = ${b.value(subject.type)}`);
  if (subject.id === "*") {
    clauses.push("subject_is_wildcard = 1");
  } else if (subject.id !== "") {
    clauses.push("subject_is_wildcard = 0");
    clauses.push(`subject_id = ${b.value(subject.id)}`);
  }
  if (subject.relation !== undefined && subject.relation !== "") {
    clauses.push(`subject_relation = ${b.value(subject.relation)}`);
  }
}

function encodeExpiresAt(expiresAt: Date | undefined): number | null {
  if (expiresAt === undefined) return null;
  const ms = expiresAt.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error("Authorization relationship expiresAt must be a valid Date");
  }
  return ms;
}

function matchesTarget(target: SqliteRelationTarget, subject: SubjectRef): boolean {
  if (target.entity !== subject.type) return false;
  if (target.kind === "wildcard") {
    return subject.id === "*" && subject.relation === undefined;
  }
  if (subject.id === "*") return false;
  return target.kind === "subject-set" ? target.relation === subject.relation : subject.relation === undefined;
}

function sqliteColumnMutationError(columnRel: CompiledSqliteColumnRelation): Error {
  return new Error(
    `Relation ${columnRel.entity}#${columnRel.relation} is column-backed by ${columnRel.table}.${columnRel.targetIdColumn}; update the application table directly`,
  );
}

function requireExact(resourceType: string, resourceId: string, relation: string): void {
  if (!resourceType || !resourceId || !relation) {
    throw new Error("SQLite authorization requires an exact resource type, resource id, and relation");
  }
}
