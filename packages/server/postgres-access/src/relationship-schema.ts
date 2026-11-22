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
  expires_at timestamptz NULL,
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
CREATE INDEX IF NOT EXISTS dad_authorization_relationship_expires_at
  ON dad_authorization_relationship (namespace, expires_at)
  WHERE expires_at IS NOT NULL;
`.trim();

const relationshipExpirationSql = `
ALTER TABLE dad_authorization_relationship
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS dad_authorization_relationship_expires_at
  ON dad_authorization_relationship (namespace, expires_at)
  WHERE expires_at IS NOT NULL;
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

/** Additive migration adding relationship expiration to an existing v1 table. */
export const relationshipExpirationMigration = Object.freeze({
  adapter: "postgres-access",
  version: 2,
  id: "dad-authorization-relationship-expiration-v2",
  checksum: createHash("sha256")
    .update(relationshipExpirationSql)
    .digest("hex"),
  sql: relationshipExpirationSql,
  advisoryLockSql: "SELECT pg_advisory_xact_lock(hashtext($1))",
});
