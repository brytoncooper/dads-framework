import type {
  Authorization,
  DirectSubjectLookup,
  PermissionQuery,
  RelationshipFilter,
  RelationshipWrite,
  ResourceLookup,
  SpiceDbConsistencyToken,
  SubjectLookup,
  SubjectLookupResult,
  SubjectRef,
} from "./authorization.js";

/**
 * Hand-written in-memory fake (docs/architecture/authorization.md#testing):
 * a tuple map plus an explicit permission→relations table per resource type.
 * Unit tests seed tuples and assert decisions in milliseconds — no SpiceDB.
 *
 * The permission table mirrors the .zed fragments deliberately simply
 * (no arrows) — arrow semantics are integration-tested against real SpiceDB.
 *
 * THE TRICK EVERY NEW TEST NEEDS: because arrows don't traverse here, a
 * positive check/lookup on an owner-arrow resource uses the OWNING
 * ORGANIZATION as the subject — `{ type: "organizations/organization",
 * id: ORG_ID }` — not the end user. In production the subject is always
 * the user and SpiceDB walks user → org → resource; the fake only sees the
 * last hop. A user-subject lookup returning [] here is usually THIS, not a
 * missing tuple.
 */
export class FakeAuthorization implements Authorization {
  private readonly tuples = new Map<string, Date | undefined>();
  private readonly now: () => Date;
  private writeCounter = 0;

  constructor(
    /** e.g. { "organizations/organization": { view: ["admin","member"], manage: ["admin"] } } */
    private readonly permissions: Record<
      string,
      Record<string, readonly string[]>
    > = {},
    options?: { readonly now?: () => Date },
  ) {
    this.now = options?.now ?? (() => new Date());
  }

  seed(...writes: readonly RelationshipWrite[]): void {
    for (const write of writes) {
      this.tuples.set(key(write), write.expiresAt);
    }
  }

  check(query: PermissionQuery): Promise<boolean> {
    const relations = this.relationsFor(query.resource.type, query.permission);
    const allowed = relations.some((relation) =>
      this.hasActiveTuple(
        key({
          resource: query.resource,
          relation,
          subject: query.subject,
        }),
      ),
    );
    return Promise.resolve(allowed);
  }

  lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    const relations = this.relationsFor(query.resourceType, query.permission);
    const prefix = `${query.resourceType}:`;
    const suffixes = relations.map(
      (relation) =>
        `#${relation}@${query.subject.type}:${query.subject.id}${query.subject.relation ? `#${query.subject.relation}` : ""}`,
    );
    const ids = this.activeTuples()
      .filter(
        (tuple) =>
          tuple.startsWith(prefix) &&
          suffixes.some((suffix) => tuple.endsWith(suffix)),
      )
      .map((tuple) => tuple.slice(prefix.length).split("#")[0])
      .filter((id): id is string => id !== undefined);
    return Promise.resolve([...new Set(ids)]);
  }

  lookupSubjects(query: SubjectLookup): Promise<SubjectLookupResult> {
    const relations = new Set(
      this.relationsFor(query.resource.type, query.permission),
    );
    const subjectIds = new Set<string>();
    let hasWildcard = false;
    for (const tuple of this.activeTuples()) {
      const match = subjectForLookup(tuple, query, relations);
      if (match === undefined) continue;
      if (match === "*") {
        hasWildcard = true;
      } else {
        subjectIds.add(match);
      }
    }
    return Promise.resolve({ subjects: [...subjectIds], hasWildcard });
  }

  writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    this.seed(...writes);
    this.writeCounter += 1;
    return Promise.resolve(`fake-token-${this.writeCounter}`);
  }

  deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    for (const tuple of [...this.tuples.keys()]) {
      if (!tupleMatchesFilter(tuple, filter)) continue;
      this.tuples.delete(tuple);
    }
    this.writeCounter += 1;
    return Promise.resolve(`fake-token-${this.writeCounter}`);
  }

  relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    const prefix = `${filter.resourceType}:${filter.resourceId}#${filter.relation}@`;
    return Promise.resolve(
      this.activeTuples().some((tuple) => tuple.startsWith(prefix)),
    );
  }

  listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    const prefix = `${query.resource.type}:${query.resource.id}#${query.relation}@`;
    const subjects: SubjectRef[] = [];
    for (const tuple of this.activeTuples()) {
      if (!tuple.startsWith(prefix)) continue;
      const parsed = parseSubjectPart(tuple.slice(prefix.length));
      if (parsed !== undefined) subjects.push(parsed);
    }
    return Promise.resolve(subjects);
  }

  private hasActiveTuple(tupleKey: string): boolean {
    if (!this.tuples.has(tupleKey)) return false;
    return !this.isExpired(this.tuples.get(tupleKey));
  }

  private isExpired(expiresAt: Date | undefined): boolean {
    return (
      expiresAt !== undefined && expiresAt.getTime() <= this.now().getTime()
    );
  }

  private activeTuples(): string[] {
    const active: string[] = [];
    for (const [tuple, expiresAt] of this.tuples) {
      if (!this.isExpired(expiresAt)) active.push(tuple);
    }
    return active;
  }

  private relationsFor(
    resourceType: string,
    permission: string,
  ): readonly string[] {
    return this.permissions[resourceType]?.[permission] ?? [permission];
  }
}

function parseSubjectPart(subjectPart: string): SubjectRef | undefined {
  const hash = subjectPart.indexOf("#");
  const objectPart = hash === -1 ? subjectPart : subjectPart.slice(0, hash);
  const subjectRelation = hash === -1 ? undefined : subjectPart.slice(hash + 1);
  const colon = objectPart.indexOf(":");
  if (colon === -1) return undefined;
  return {
    type: objectPart.slice(0, colon),
    id: objectPart.slice(colon + 1),
    ...(subjectRelation ? { relation: subjectRelation } : {}),
  };
}

function subjectForLookup(
  tuple: string,
  query: SubjectLookup,
  relations: ReadonlySet<string>,
): string | undefined {
  const parts = splitTuple(tuple);
  if (
    parts === undefined ||
    parts.resourceType !== query.resource.type ||
    parts.resourceId !== query.resource.id ||
    !relations.has(parts.relation)
  ) {
    return undefined;
  }
  if (parts.subject.includes("#")) return undefined;
  const colon = parts.subject.indexOf(":");
  if (colon === -1) return undefined;
  if (parts.subject.slice(0, colon) !== query.subjectType) return undefined;
  return parts.subject.slice(colon + 1);
}

function key(write: RelationshipWrite): string {
  const subjectRelation = write.subject.relation
    ? `#${write.subject.relation}`
    : "";
  return `${write.resource.type}:${write.resource.id}#${write.relation}@${write.subject.type}:${write.subject.id}${subjectRelation}`;
}

function subjectMatches(subjectPart: string, filter: SubjectRef): boolean {
  const hash = subjectPart.indexOf("#");
  const objectPart = hash === -1 ? subjectPart : subjectPart.slice(0, hash);
  const subjectRelation = hash === -1 ? undefined : subjectPart.slice(hash + 1);
  const colon = objectPart.indexOf(":");
  if (colon === -1) return false;
  if (objectPart.slice(0, colon) !== filter.type) return false;
  if (objectPart.slice(colon + 1) !== filter.id) return false;
  if (filter.relation !== undefined && subjectRelation !== filter.relation) {
    return false;
  }
  return true;
}

function tupleMatchesFilter(
  tuple: string,
  filter: RelationshipFilter,
): boolean {
  const parts = splitTuple(tuple);
  if (parts === undefined || parts.resourceType !== filter.resourceType)
    return false;
  if (filter.resourceId && parts.resourceId !== filter.resourceId) return false;
  if (filter.relation && parts.relation !== filter.relation) return false;
  return (
    filter.subject === undefined ||
    subjectMatches(parts.subject, filter.subject)
  );
}

function splitTuple(tuple: string) {
  // Preserve the second # delimiter, which belongs to the subject relation.
  const hash = tuple.indexOf("#");
  if (hash === -1) return undefined;
  const resource = tuple.slice(0, hash);
  const rest = tuple.slice(hash + 1);
  if (!resource || !rest) return undefined;
  const at = rest.indexOf("@");
  if (at === -1) return undefined;
  const [resourceType, resourceId] = resource.split(":", 2);
  return {
    resourceType,
    resourceId,
    relation: rest.slice(0, at),
    subject: rest.slice(at + 1),
  };
}
