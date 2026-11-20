import {
  configureAuditTriggers,
  installAuditSchemaV1,
} from "@dads-framework/audit";
import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags-postgres";
import { installIdentitySchemaV1 } from "@dads-framework/identity-better-auth";
import { relationshipSchemaMigration } from "@dads-framework/postgres-access";
import {
  installTenantSchemaV1,
  tenantAuditConfiguration,
} from "@dads-framework/tenants";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(relationshipSchemaMigration.sql);
  installIdentitySchemaV1(pgm);
  installTenantSchemaV1(pgm);
  installFeatureFlagSchemaV1(pgm);
  installAuditSchemaV1(pgm);
  pgm.sql(`
    CREATE TABLE starter_note (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      text text NOT NULL,
      CHECK (length(text) BETWEEN 1 AND 2000)
    );
    CREATE INDEX starter_note_tenant ON starter_note (tenant_id);
  `);
  configureAuditTriggers(pgm, {
    ...tenantAuditConfiguration,
    tables: {
      ...tenantAuditConfiguration.tables,
      starter_note: {
        keyColumns: ["id"],
        scopeColumns: { tenant_id: "tenant_id" },
      },
    },
  });
}

/** Bootstrap migrations only move forward. */
export const down = false;
