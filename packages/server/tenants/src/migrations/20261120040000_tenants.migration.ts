import type { MigrationBuilder } from "node-pg-migrate";

export function installTenantSchemaV1(
  pgm: Pick<MigrationBuilder, "sql">,
): void {
  pgm.sql(`
    CREATE TABLE tenant (
      id uuid PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TABLE tenant_membership (
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      account_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      PRIMARY KEY (tenant_id, account_id)
    );
    CREATE TABLE tenant_invitation (
      token_hash text PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      recipient_email text NOT NULL,
      issued_by text NOT NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz
    );
  `);
}

export function up(pgm: MigrationBuilder): void {
  installTenantSchemaV1(pgm);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("tenant_invitation");
  pgm.dropTable("tenant_membership");
  pgm.dropTable("tenant");
}
