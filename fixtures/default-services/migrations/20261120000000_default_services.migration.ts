import { installIdentitySchemaV2 } from "@dads-framework/identity/better-auth";
import { relationshipSchemaMigration } from "@dads-framework/postgres-access";
import { installTenantSchemaV2 } from "@dads-framework/identity/tenants";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(relationshipSchemaMigration.sql);
  installIdentitySchemaV2(pgm);
  installTenantSchemaV2(pgm);
}

export const down = false;
