import type {
  DirectSubjectLookup,
  PermissionQuery,
  RelationshipFilter,
  RelationshipWrite,
  RelationshipPage,
  RelationshipPageRequest,
  SpiceDbConsistencyToken,
  SubjectRef,
} from "@dads-framework/access/runtime";

/**
 * What a migration's relationship steps may do. Deliberately narrower than
 * the Authorization seam: steps move, delete, read, and verify relationships —
 * they never write schemas (the runner owns the schema write) and never look
 * up resources for product behavior.
 */
export type AuthorizationMigrationClient = {
  /** Deletes precisely one tuple, distinguishing a direct subject from its usersets. */
  deleteExactRelationship(fact: RelationshipWrite): Promise<SpiceDbConsistencyToken>;
  readRelationshipPage(query: RelationshipPageRequest): Promise<RelationshipPage>;
  writeRelationships(writes: readonly RelationshipWrite[]): Promise<SpiceDbConsistencyToken>;
  deleteRelationships(filter: RelationshipFilter): Promise<SpiceDbConsistencyToken>;
  listDirectSubjects(query: DirectSubjectLookup): Promise<readonly SubjectRef[]>;
  check(query: PermissionQuery): Promise<boolean>;
};

/**
 * The runner's full store surface: everything steps get, plus the schema
 * read/write. `SpiceDbAuthorization` satisfies it structurally, and it is a
 * superset of the kit's `AuthorizationSchemaStore`, so the genesis path can
 * hand the same store to `applyDesiredAuthorizationSchema`.
 */
export type AuthorizationMigrationStore = AuthorizationMigrationClient & {
  readSchema(): Promise<string>;
  writeSchema(schema: string): Promise<void>;
};

export type AuthorizationMigrationStep = (client: AuthorizationMigrationClient) => Promise<void>;

/**
 * One journal entry, as authored in
 * <journal folder>/<id>/migration.ts. The id doubles
 * as the folder name holding this entry's schema.zed snapshot, and as the
 * `authz/migration_version` object id recorded once the entry applies.
 */
export type AuthorizationMigration = {
  /** `NNNN_slug`, e.g. "0001_baseline". Numbering is sequential from 0001. */
  readonly id: string;
  /** Relationship work that makes the schema write legal (deletes/moves). */
  readonly beforeSchemaWrite?: AuthorizationMigrationStep;
  /** Relationship work that only makes sense under the new schema (backfills). */
  readonly afterSchemaWrite?: AuthorizationMigrationStep;
};

/** A journal entry joined with the schema snapshot read from its folder. */
export type LoadedAuthorizationMigration = AuthorizationMigration & {
  readonly number: number;
  readonly schema: string;
};
