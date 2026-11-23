import type {
  DirectSubjectLookup,
  RelationshipFilter,
  RelationshipWrite,
  SubjectRef,
} from "@dads-framework/access/runtime";
import type { AuthorizationMigrationStore } from "../lib/journal/journal-entry.js";
import { JOURNAL_DEFINITION } from "../lib/journal/load-journal.js";

/**
 * In-memory stand-in for SpiceDB with the behaviors the runner depends on:
 * readSchema returns whatever was last written ("" for a store that never
 * received a schema, exactly like the adapter), and journal markers are
 * plain relationships on the well-known journal resource.
 */
export class FakeSchemaStore implements AuthorizationMigrationStore {
  readonly operations: string[] = [];
  readonly appliedMarkers: string[] = [];
  private liveSchema: string;
  private failNextSchemaWrite: string | undefined;

  constructor(options?: { initialSchema?: string }) {
    this.liveSchema = options?.initialSchema ?? "";
  }

  /** Makes the next writeSchema reject with the given message. */
  failOnNextSchemaWrite(message: string): void {
    this.failNextSchemaWrite = message;
  }

  readSchema(): Promise<string> {
    return Promise.resolve(this.liveSchema);
  }

  writeSchema(schema: string): Promise<void> {
    if (this.failNextSchemaWrite !== undefined) {
      const message = this.failNextSchemaWrite;
      this.failNextSchemaWrite = undefined;
      return Promise.reject(new Error(message));
    }
    this.operations.push(`writeSchema:${firstCommentTag(schema)}`);
    this.liveSchema = schema;
    return Promise.resolve();
  }

  writeRelationships(writes: readonly RelationshipWrite[]): Promise<string> {
    for (const write of writes) {
      if (write.resource.type === JOURNAL_DEFINITION && write.relation === "applied") {
        this.appliedMarkers.push(write.subject.id);
      }
      this.operations.push(`write:${write.resource.type}:${write.resource.id}:${write.relation}:${write.subject.id}`);
    }
    return Promise.resolve("");
  }

  deleteRelationships(filter: RelationshipFilter): Promise<string> {
    this.operations.push(`delete:${filter.resourceType}${filter.relation === undefined ? "" : `#${filter.relation}`}`);
    return Promise.resolve("");
  }

  deleteExactRelationship(fact: RelationshipWrite): Promise<string> {
    if (fact.resource.type === JOURNAL_DEFINITION && fact.relation === "applied") {
      const marker = this.appliedMarkers.indexOf(fact.subject.id);
      if (marker !== -1) this.appliedMarkers.splice(marker, 1);
    }
    this.operations.push(
      `deleteExact:${fact.resource.type}:${fact.resource.id}:${fact.relation}:${fact.subject.type}:${fact.subject.id}:${fact.subject.relation ?? ""}`,
    );
    return Promise.resolve("");
  }

  listDirectSubjects(query: DirectSubjectLookup): Promise<readonly SubjectRef[]> {
    if (query.resource.type !== JOURNAL_DEFINITION) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      this.appliedMarkers.map((id) => ({
        type: "authz/migration_version",
        id,
      })),
    );
  }

  check(): Promise<boolean> {
    return Promise.resolve(false);
  }

  readRelationshipPage() {
    return Promise.resolve({ relationships: [], nextCursor: null });
  }
}

/**
 * Snapshots in tests start with `// vN` so operation logs can name which
 * snapshot a writeSchema call carried.
 */
function firstCommentTag(schema: string): string {
  const match = /^\/\/ (\S+)/.exec(schema);
  return match?.[1] ?? "untagged";
}
