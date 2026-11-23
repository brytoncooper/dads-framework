import type { MigrationBuilder } from "node-pg-migrate";

export function installTenantScimGroupSchemaV1(
  pgm: Pick<MigrationBuilder, "sql">,
): void {
  pgm.sql(`
    CREATE TABLE tenant_scim_group (
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      id uuid NOT NULL,
      display_name text NOT NULL,
      display_name_key text NOT NULL,
      external_id text,
      created_at timestamptz NOT NULL,
      modified_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE tenant_scim_group_member (
      tenant_id uuid NOT NULL,
      group_id uuid NOT NULL,
      user_id uuid NOT NULL,
      PRIMARY KEY (tenant_id, group_id, user_id),
      FOREIGN KEY (tenant_id, group_id)
        REFERENCES tenant_scim_group (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, user_id)
        REFERENCES tenant_scim_user (tenant_id, id)
    );
    CREATE INDEX tenant_scim_group_member_user
      ON tenant_scim_group_member (tenant_id, user_id);
  `);
}

export function up(pgm: MigrationBuilder): void {
  installTenantScimGroupSchemaV1(pgm);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("tenant_scim_group_member");
  pgm.dropTable("tenant_scim_group");
}
