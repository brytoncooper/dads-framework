import type { MigrationBuilder } from "node-pg-migrate";

export function installTenantScimSchemaV1(
  pgm: Pick<MigrationBuilder, "sql">,
): void {
  pgm.sql(`
    CREATE TABLE tenant_scim_user (
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      id uuid NOT NULL,
      user_name text NOT NULL,
      user_name_key text NOT NULL,
      active boolean NOT NULL,
      external_id text,
      display_name text,
      display_name_key text,
      name jsonb,
      emails jsonb,
      email_keys text[],
      account_id text,
      created_at timestamptz NOT NULL,
      modified_at timestamptz NOT NULL,
      deleted_at timestamptz,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, account_id),
      CHECK (deleted_at IS NULL OR NOT active)
    );
    CREATE UNIQUE INDEX tenant_scim_user_live_name
      ON tenant_scim_user (tenant_id, user_name_key)
      WHERE deleted_at IS NULL;
  `);
}

export function up(pgm: MigrationBuilder): void {
  installTenantScimSchemaV1(pgm);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("tenant_scim_user");
}
