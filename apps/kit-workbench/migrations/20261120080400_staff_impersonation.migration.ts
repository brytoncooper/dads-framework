import { installStaffImpersonationSchemaV1 } from "@dads-framework/identity-better-auth/impersonation-store";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  installStaffImpersonationSchemaV1(pgm);
}

/** Keep the staff impersonation audit trail on rollback. */
export const down = false;
