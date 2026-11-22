import { createHash } from "node:crypto";

export const SQLITE_RELATIONSHIP_TABLE = "dad_authorization_relationship";

const createTableSql = `
CREATE TABLE IF NOT EXISTS ${SQLITE_RELATIONSHIP_TABLE} (
  namespace TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL DEFAULT '',
  subject_relation TEXT NOT NULL DEFAULT '',
  subject_is_wildcard INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NULL,
  CHECK (subject_is_wildcard IN (0, 1)),
  CHECK (
    (subject_is_wildcard = 0 AND subject_id <> '') OR
    (subject_is_wildcard = 1 AND subject_id = '' AND subject_relation = '')
  ),
  PRIMARY KEY (
    namespace, resource_kind, resource_id, relation,
    subject_kind, subject_id, subject_relation, subject_is_wildcard
  )
);
`.trim();

const createSubjectLookupIndexSql = `
CREATE INDEX IF NOT EXISTS dad_authorization_relationship_subject_lookup
  ON ${SQLITE_RELATIONSHIP_TABLE} (
    namespace, subject_kind, subject_id, resource_kind, resource_id, relation
  );
`.trim();

const createExpiresAtIndexSql = `
CREATE INDEX IF NOT EXISTS dad_authorization_relationship_expires_at
  ON ${SQLITE_RELATIONSHIP_TABLE} (expires_at)
  WHERE expires_at IS NOT NULL;
`.trim();

const statements: readonly string[] = Object.freeze([
  createTableSql,
  createSubjectLookupIndexSql,
  createExpiresAtIndexSql,
]);

const relationshipSchemaSql = statements.join("\n");

export type SqliteSchemaMigration = {
  readonly id: string;
  readonly version: number;
  readonly adapter: "sqlite-access";
  readonly checksum: string;
  readonly sql: string;
  readonly statements: readonly string[];
};

/** Application-applied migration for the SQLite tuple store and its indexes. */
export const sqliteRelationshipSchemaMigration: SqliteSchemaMigration =
  Object.freeze({
    id: "dad-authorization-relationship-sqlite-v1",
    version: 1,
    adapter: "sqlite-access",
    checksum: createHash("sha256").update(relationshipSchemaSql).digest("hex"),
    sql: relationshipSchemaSql,
    statements,
  });
