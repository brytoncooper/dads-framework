import {
  installIdentityEnterpriseSsoSchema,
  installIdentitySigningKeyMetadataSchema,
} from "@dads-framework/identity-better-auth";
import {
  installTenantScimGroupSchemaV1,
  installTenantScimSchemaV1,
} from "@dads-framework/tenants";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  installIdentitySigningKeyMetadataSchema(pgm);
  installIdentityEnterpriseSsoSchema(pgm);
  installTenantScimSchemaV1(pgm);
  installTenantScimGroupSchemaV1(pgm);
}

/** Keep provisioned users and enterprise session provenance on rollback. */
export const down = false;
