import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn: readonly string[] = [
  "20261120070500_identity.migration",
];

export function up(migration: MigrationBuilder): void {
  migration.sql(`
    CREATE TABLE identity_sso_providers (
      id text PRIMARY KEY,
      issuer text NOT NULL,
      "oidcConfig" text,
      "samlConfig" text,
      "userId" text NOT NULL REFERENCES identity_users (id) ON DELETE CASCADE,
      "providerId" text NOT NULL UNIQUE,
      "organizationId" text,
      domain text NOT NULL,
      "domainVerified" boolean,
      CONSTRAINT identity_sso_providers_configuration_only CHECK (false)
    );
    ALTER TABLE identity_sessions ADD COLUMN "ssoProviderBinding" text;
    ALTER TABLE identity_credentials ADD COLUMN "ssoProviderBinding" text;
    CREATE UNIQUE INDEX identity_credentials_enterprise_provider_user_idx
      ON identity_credentials ("providerId", "userId")
      WHERE "providerId" LIKE 'sso-%';
  `);
}

export function down(migration: MigrationBuilder): void {
  migration.sql(`
    DROP TABLE identity_sso_providers;
    DROP INDEX identity_credentials_enterprise_provider_user_idx;
    ALTER TABLE identity_sessions DROP COLUMN "ssoProviderBinding";
    ALTER TABLE identity_credentials DROP COLUMN "ssoProviderBinding";
  `);
}
