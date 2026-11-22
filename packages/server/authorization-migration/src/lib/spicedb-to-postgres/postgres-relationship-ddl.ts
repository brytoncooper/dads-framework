import {
  assertSqlIdentifier,
  DEFAULT_RELATIONSHIP_TABLE,
  type PgMigrationClient,
} from "../access-migrations/sql-migration-types.js";

/**
 * Matches `@dads-framework/postgres-access`'s `relationshipSchemaMigration`
 * DDL so migrated rows are immediately queryable by `PostgresAuthorization`.
 */
export function buildPostgresRelationshipSchemaSql(
  tableName: string = DEFAULT_RELATIONSHIP_TABLE,
): string {
  const table = assertSqlIdentifier(tableName, "relationshipTable");
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  namespace text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  relation text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL DEFAULT '',
  subject_relation text NOT NULL DEFAULT '',
  subject_is_wildcard boolean NOT NULL DEFAULT false,
  expires_at timestamptz NULL,
  CONSTRAINT ${table}_subject_shape CHECK (
    (subject_is_wildcard = false AND subject_id <> '') OR
    (subject_is_wildcard = true AND subject_id = '' AND subject_relation = '')
  ),
  PRIMARY KEY (
    namespace, resource_kind, resource_id, relation,
    subject_kind, subject_id, subject_relation, subject_is_wildcard
  )
);
CREATE INDEX IF NOT EXISTS ${table}_subject_lookup
  ON ${table} (
    namespace, subject_kind, subject_id, resource_kind, resource_id, relation
  );
CREATE INDEX IF NOT EXISTS ${table}_expires_at
  ON ${table} (namespace, expires_at)
  WHERE expires_at IS NOT NULL;
`.trim();
}

/**
 * Matches `@dads-framework/postgres-access`'s `relationshipExpirationMigration`
 * DDL to ensure existing v1 tables gain `expires_at` before bulk writes.
 */
export function buildPostgresRelationshipExpirationSql(
  tableName: string = DEFAULT_RELATIONSHIP_TABLE,
): string {
  const table = assertSqlIdentifier(tableName, "relationshipTable");
  return `
ALTER TABLE ${table}
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS ${table}_expires_at
  ON ${table} (namespace, expires_at)
  WHERE expires_at IS NOT NULL;
`.trim();
}

export async function ensurePostgresRelationshipSchema(
  client: PgMigrationClient,
  tableName: string,
  customSchemaSql?: readonly string[],
): Promise<void> {
  const statements = customSchemaSql ?? [
    buildPostgresRelationshipSchemaSql(tableName),
    buildPostgresRelationshipExpirationSql(tableName),
  ];
  for (const sql of statements) {
    await client.query(sql);
  }
}
