import { createHash } from "node:crypto";

export const RELATIONSHIP_TABLE = "dad_authorization_relationship";

const relationshipSchemaSql = `
CREATE TABLE IF NOT EXISTS dad_authorization_relationship (
  namespace text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  relation text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL DEFAULT '',
  subject_relation text NOT NULL DEFAULT '',
  subject_is_wildcard boolean NOT NULL DEFAULT false,
  CONSTRAINT dad_authorization_relationship_subject_shape CHECK (
    (subject_is_wildcard = false AND subject_id <> '') OR
    (subject_is_wildcard = true AND subject_id = '' AND subject_relation = '')
  ),
  PRIMARY KEY (
    namespace, resource_kind, resource_id, relation,
    subject_kind, subject_id, subject_relation, subject_is_wildcard
  )
);
CREATE INDEX IF NOT EXISTS dad_authorization_relationship_subject_lookup
  ON dad_authorization_relationship (
    namespace, subject_kind, subject_id, resource_kind, resource_id, relation
  );
`.trim();

/** Application-applied migration for the tuple store and its reverse lookup index. */
export const relationshipSchemaMigration = Object.freeze({
  adapter: "postgres-access",
  version: 1,
  id: "dad-authorization-relationship-v1",
  checksum: createHash("sha256").update(relationshipSchemaSql).digest("hex"),
  sql: relationshipSchemaSql,
  advisoryLockSql: "SELECT pg_advisory_xact_lock(hashtext($1))",
});
