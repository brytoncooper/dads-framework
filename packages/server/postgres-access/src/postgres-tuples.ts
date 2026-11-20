import { RELATIONSHIP_TABLE } from "./relationship-schema.js";
import type {
  DirectSubjectLookup,
  RelationshipFilter,
  RelationshipWrite,
  SubjectRef,
} from "@dads-framework/access/runtime";
import { type PostgresQuery, type PostgresRow } from "./postgres-types.js";
import type {
  AuthorizationModelDefinition,
  CompiledAuthorizationRelationTarget,
} from "./policy/policy-model.js";
import { readTupleColumn } from "./postgres-response.js";

type Execute = (query: PostgresQuery) => Promise<readonly PostgresRow[]>;
type ExactFilter = Required<
  Pick<RelationshipFilter, "resourceType" | "resourceId" | "relation">
>;

const tupleFilter =
  "namespace = $1 AND resource_kind = $2 AND ($3::text IS NULL OR resource_id = $3) AND ($4::text IS NULL OR relation = $4)";
const subjectFilter =
  "($5::text IS NULL OR subject_kind = $5) AND ($6::text IS NULL OR (CASE WHEN subject_is_wildcard THEN '*' ELSE subject_id END) = $6) AND ($7::text IS NULL OR subject_relation = $7)";

export class PostgresTuples {
  constructor(
    private readonly model: AuthorizationModelDefinition,
    private readonly namespace: string,
    private readonly execute: Execute,
  ) {}

  async write(writes: readonly RelationshipWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const rows = writes.map((write) => this.#validateWrite(write));
    await this.execute({
      text: `INSERT INTO ${RELATIONSHIP_TABLE} (namespace, resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard)
        SELECT $1, kind, resource, relation, subject, subject_id, subject_relation, wildcard
        FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[])
        AS input(kind, resource, relation, subject, subject_id, subject_relation, wildcard) ON CONFLICT DO NOTHING`,
      values: [
        this.namespace,
        rows.map(({ resource }) => resource.type),
        rows.map(({ resource }) => resource.id),
        rows.map(({ relation }) => relation),
        rows.map(({ subject }) => subject.type),
        rows.map(({ subject }) => (subject.id === "*" ? "" : subject.id)),
        rows.map(({ subject }) => subject.relation ?? ""),
        rows.map(({ subject }) => subject.id === "*"),
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
    const rows = await this.execute({
      text: `SELECT 1 FROM ${RELATIONSHIP_TABLE} WHERE ${tupleFilter} LIMIT 1`,
      values: this.#resourceFilter(filter),
    });
    return rows.length > 0;
  }

  async list(query: DirectSubjectLookup): Promise<readonly SubjectRef[]> {
    requireExact(query.resource.id, query.relation);
    const rows = await this.execute({
      text: `SELECT subject_kind, CASE WHEN subject_is_wildcard THEN '*' ELSE subject_id END AS subject_id, subject_relation
        FROM ${RELATIONSHIP_TABLE} WHERE ${tupleFilter}
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
    if (filter.resourceType === "")
      throw new Error("Postgres authorization requires a resource type");
    return [
      this.namespace,
      filter.resourceType,
      filter.resourceId || null,
      filter.relation || null,
    ];
  }

  #validateWrite(write: RelationshipWrite): RelationshipWrite {
    const relation = this.model.relations.find(
      (entry) =>
        entry.entity === write.resource.type &&
        entry.wireName === write.relation,
    );
    if (
      relation === undefined ||
      !relation.targets.some((target) => matchesTarget(target, write.subject))
    ) {
      throw new Error(
        `Invalid authorization relationship ${write.resource.type}#${write.relation}`,
      );
    }
    if (
      write.resource.id === "" ||
      write.resource.id === "*" ||
      write.subject.id === ""
    ) {
      throw new Error(
        "An authorization relationship requires resource and subject identifiers",
      );
    }
    return write;
  }
}

function matchesTarget(
  target: CompiledAuthorizationRelationTarget,
  subject: SubjectRef,
): boolean {
  if (target.entity !== subject.type) return false;
  if (target.kind === "wildcard")
    return subject.id === "*" && subject.relation === undefined;
  if (subject.id === "*") return false;
  return target.kind === "subject-set"
    ? target.relation === subject.relation
    : subject.relation === undefined;
}

function requireExact(resourceId: string, relation: string): void {
  if (!resourceId || !relation)
    throw new Error(
      "Postgres authorization requires an exact resource id and relation",
    );
}
