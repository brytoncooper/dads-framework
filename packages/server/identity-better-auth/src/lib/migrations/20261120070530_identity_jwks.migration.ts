import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn: readonly string[] = [
  "20261120070500_identity.migration",
];

export function up(migration: MigrationBuilder): void {
  migration.sql(
    "ALTER TABLE identity_signing_keys ADD COLUMN alg text, ADD COLUMN crv text",
  );
}

export function down(migration: MigrationBuilder): void {
  migration.sql(
    "ALTER TABLE identity_signing_keys DROP COLUMN alg, DROP COLUMN crv",
  );
}
