import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn: readonly string[] = [
  "20261120070500_identity.migration",
];

export function installStaffImpersonationSchemaV1(
  migration: MigrationBuilder,
): void {
  migration.sql(`
    CREATE TABLE identity_staff_impersonation_grants (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      staff_account_id text NOT NULL,
      staff_session_id text NOT NULL,
      effective_account_id text NOT NULL,
      expires_at_ms bigint NOT NULL,
      CHECK (staff_account_id <> effective_account_id)
    );

    CREATE INDEX identity_staff_impersonation_grants_expiry
      ON identity_staff_impersonation_grants (expires_at_ms);

    CREATE TABLE identity_staff_impersonation_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event jsonb NOT NULL
    );

    CREATE INDEX identity_staff_impersonation_audit_tenant
      ON identity_staff_impersonation_audit ((event->>'tenantId'), id);
  `);
}

export function up(migration: MigrationBuilder): void {
  installStaffImpersonationSchemaV1(migration);
}

export function down(migration: MigrationBuilder): void {
  migration.sql(`
    DROP TABLE identity_staff_impersonation_grants;
    DROP TABLE identity_staff_impersonation_audit;
  `);
}
