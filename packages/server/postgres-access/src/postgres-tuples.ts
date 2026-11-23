import { RELATIONSHIP_TABLE } from "./relationship-schema.js";
import type {
  DirectSubjectLookup,
  RelationshipFilter,
  RelationshipWrite,
  SubjectRef,
} from "@dads-framework/access/runtime";
import { type PostgresQuery, type PostgresRow } from "./postgres-types.js";
import { findColumnRelation } from "./policy/column-relations.js";
import type {
  AuthorizationModelDefinition,
  CompiledAuthorizationRelationTarget,
  CompiledColumnRelation,
} from "./policy/policy-model.js";
import { readTupleColumn } from "./postgres-response.js";

type Execute = (query: PostgresQuery) => Promise<readonly PostgresRow[]>;
type ExactFilter = Required<Pick<RelationshipFilter, "resourceType" | "resourceId" | "relation">>;

const tupleFilter =
  "namespace = $1 AND resource_kind = $2 AND ($3::text IS NULL OR resource_id = $3) AND ($4::text IS NULL OR relation = $4)";
const subjectFilter =
  "($5::text IS NULL OR subject_kind = $5) AND ($6::text IS NULL OR (CASE WHEN subject_is_wildcard THEN '*' ELSE subject_id END) = $6) AND ($7::text IS NULL OR subject_relation = $7)";
const notExpiredTuple = "(expires_at IS NULL OR expires_at > now())";
const relationshipPrimaryKey =
  "(namespace, resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard)";

export class PostgresTuples {
  constructor(
    private readonly model: AuthorizationModelDefinition,
    private readonly namespace: string,
    private readonly execute: Execute,
  ) {}

  async write(writes: readonly RelationshipWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const rows = deduplicateWrites(writes.map((write) => this.#validateWrite(write)));
    await this.execute({
      text: `INSERT INTO ${RELATIONSHIP_TABLE} (namespace, resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at)
        SELECT $1, kind, resource, relation, subject, subject_id, subject_relation, wildcard, expires_at
        FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::timestamptz[])
        AS input(kind, resource, relation, subject, subject_id, subject_relation, wildcard, expires_at)
        ON CONFLICT ${relationshipPrimaryKey} DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      values: [
        this.namespace,
        rows.map(({ resource }) => resource.type),
        rows.map(({ resource }) => resource.id),
        rows.map(({ relation }) => relation),
        rows.map(({ subject }) => subject.type),
        rows.map(({ subject }) => (subject.id === "*" ? "" : subject.id)),
        rows.map(({ subject }) => subject.relation ?? ""),
        rows.map(({ subject }) => subject.id === "*"),
        rows.map(({ expiresAt }) => expiresAt ?? null),
      ],
    });
  }

  async remove(write: RelationshipWrite): Promise<void> {
    const tuple = this.#validateWrite(write);
    const { resource, relation, subject } = tuple;
    await this.execute({
      text: `DELETE FROM ${RELATIONSHIP_TABLE} WHERE namespace = $1 AND resource_kind = $2
        AND resource_id = $3 AND relation = $4 AND subject_kind = $5 AND subject_id = $6
        AND subject_relation = $7 AND subject_is_wildcard = $8`,
      values: [
        this.namespace,
        resource.type,
        resource.id,
        relation,
        subject.type,
        subject.id === "*" ? "" : subject.id,
        subject.relation ?? "",
        subject.id === "*",
      ],
    });
  }

  async delete(filter: RelationshipFilter): Promise<void> {
    if (filter.relation !== undefined && filter.relation !== "") {
      const columnRel = findColumnRelation(this.model, filter.resourceType, filter.relation);
      if (columnRel !== undefined) {
        throw columnBackedMutationError(columnRel);
      }
    }
    await this.execute({
      text: `DELETE FROM ${RELATIONSHIP_TABLE} WHERE ${tupleFilter} AND ${subjectFilter}`,
      values: [
        ...this.#resourceFilter(filter),
        filter.subject?.type ?? null,
        filter.subject?.id || null,
        filter.subject?.relation || null,
      ],
    });
  }

  async exists(filter: ExactFilter): Promise<boolean> {
    requireExact(filter.resourceId, filter.relation);
    const columnRel = findColumnRelation(this.model, filter.resourceType, filter.relation);
    if (columnRel !== undefined) {
      const rows = await this.execute({
        text: `SELECT 1 FROM ${columnRel.table} WHERE ${columnRel.idColumn}::text = ($1)::text AND ${columnRel.targetIdColumn} IS NOT NULL LIMIT 1`,
        values: [filter.resourceId],
      });
      return rows.length > 0;
    }
    const rows = await this.execute({
      text: `SELECT 1 FROM ${RELATIONSHIP_TABLE} WHERE ${tupleFilter} AND ${notExpiredTuple} LIMIT 1`,
      values: this.#resourceFilter(filter),
    });
    return rows.length > 0;
  }

  async list(query: DirectSubjectLookup): Promise<readonly SubjectRef[]> {
    requireExact(query.resource.id, query.relation);
    const columnRel = findColumnRelation(this.model, query.resource.type, query.relation);
    if (columnRel !== undefined) {
      const rows = await this.execute({
        text: `SELECT DISTINCT ${columnRel.targetIdColumn}::text AS subject_id FROM ${columnRel.table} WHERE ${columnRel.idColumn}::text = ($1)::text AND ${columnRel.targetIdColumn} IS NOT NULL ORDER BY subject_id`,
        values: [query.resource.id],
      });
      return rows.map((row) => ({
        type: columnRel.targetEntity,
        id: readTupleColumn(row, "subject_id"),
      }));
    }
    const rows = await this.execute({
      text: `SELECT subject_kind, CASE WHEN subject_is_wildcard THEN '*' ELSE subject_id END AS subject_id, subject_relation
        FROM ${RELATIONSHIP_TABLE} WHERE ${tupleFilter} AND ${notExpiredTuple}
        ORDER BY subject_kind, subject_id, subject_relation`,
      values: this.#resourceFilter({
        resourceType: query.resource.type,
        resourceId: query.resource.id,
        relation: query.relation,
      }),
    });
    return rows.map((row) => {
      const relation = readTupleColumn(row, "subject_relation");
      return {
        type: readTupleColumn(row, "subject_kind"),
        id: readTupleColumn(row, "subject_id"),
        ...(relation === "" ? {} : { relation }),
      };
    });
  }

  #resourceFilter(filter: RelationshipFilter): (string | null)[] {
    if (filter.resourceType === "") throw new Error("Postgres authorization requires a resource type");
    return [this.namespace, filter.resourceType, filter.resourceId || null, filter.relation || null];
  }

  #validateWrite(write: RelationshipWrite): RelationshipWrite {
    const columnRel = findColumnRelation(this.model, write.resource.type, write.relation);
    if (columnRel !== undefined) {
      throw columnBackedMutationError(columnRel);
    }
    const relation = this.model.relations.find(
      (entry) => entry.entity === write.resource.type && entry.wireName === write.relation,
    );
    if (relation === undefined || !relation.targets.some((target) => matchesTarget(target, write.subject))) {
      throw new Error(`Invalid authorization relationship ${write.resource.type}#${write.relation}`);
    }
    if (write.resource.id === "" || write.resource.id === "*" || write.subject.id === "") {
      throw new Error("An authorization relationship requires resource and subject identifiers");
    }
    if (write.expiresAt !== undefined && Number.isNaN(write.expiresAt.getTime())) {
      throw new Error("An authorization relationship expiration must be a valid Date");
    }
    return write;
  }
}

function deduplicateWrites(writes: readonly RelationshipWrite[]): readonly RelationshipWrite[] {
  const byKey = new Map<string, RelationshipWrite>();
  for (const write of writes) {
    const key = [
      write.resource.type,
      write.resource.id,
      write.relation,
      write.subject.type,
      write.subject.id === "*" ? "" : write.subject.id,
      write.subject.relation ?? "",
      write.subject.id === "*" ? "1" : "0",
    ].join("\u0000");
    byKey.set(key, write);
  }
  return [...byKey.values()];
}

function matchesTarget(target: CompiledAuthorizationRelationTarget, subject: SubjectRef): boolean {
  if (target.entity !== subject.type) return false;
  if (target.kind === "wildcard") return subject.id === "*" && subject.relation === undefined;
  if (subject.id === "*") return false;
  return target.kind === "subject-set" ? target.relation === subject.relation : subject.relation === undefined;
}

function columnBackedMutationError(columnRel: CompiledColumnRelation): Error {
  return new Error(
    `Relation ${columnRel.entity}#${columnRel.relation} is column-backed by ${columnRel.table}.${columnRel.targetIdColumn}; update the application table directly`,
  );
}

function requireExact(resourceId: string, relation: string): void {
  if (!resourceId || !relation) throw new Error("Postgres authorization requires an exact resource id and relation");
}
