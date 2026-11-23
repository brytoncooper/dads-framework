import type { MigrationBuilder } from "node-pg-migrate";

import { installTenantSchemaV1 } from "./migrations/20261120040000_tenants.migration.js";
import { installTenantScimSchemaV1 } from "./migrations/20261120080000_tenant_scim.migration.js";
import { installTenantScimGroupSchemaV1 } from "./migrations/20261120080100_tenant_scim_groups.migration.js";

/** Install the V2 tenant schema on a fresh database, including directory storage. */
export function installTenantSchemaV2(
  pgm: Pick<MigrationBuilder, "sql">,
): void {
  installTenantSchemaV1(pgm);
  installTenantScimSchemaV1(pgm);
  installTenantScimGroupSchemaV1(pgm);
}
