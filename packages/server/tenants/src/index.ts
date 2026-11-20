export {
  assignableTenantRoleSchema,
  createTenantAccess,
  tenantEntity,
  tenantIdSchema,
  tenantRoles,
  type TenantAccess,
  type TenantId,
  type TenantRole,
} from "./tenant-access.js";
export {
  createTenantDirectory,
  tenantAuditConfiguration,
} from "./tenant-composition.js";
export {
  type AuthenticatedTenantAccount,
  type TenantInvitationAcceptanceCheck,
  TenantInvitationUnavailableError,
} from "./tenant-invitations.js";
export type { TenantMembership } from "./tenant-memberships.js";
export {
  TenantUnavailableError,
  type TenantsOptions,
  type TenantTransaction,
} from "./tenant-transaction.js";
export { Tenants, type TenantContext, type TenantRecord } from "./tenants.js";

export { tenantMigrations } from "./tenant-migrations.js";

export { installTenantSchemaV2 } from "./install-tenant-schema-v2.js";
export { installTenantSchemaV1 } from "./migrations/20261120040000_tenants.migration.js";

export { createTenantScimDirectory } from "./tenant-scim-directory.js";
export { installTenantScimSchemaV1 } from "./migrations/20261120080000_tenant_scim.migration.js";
export { createTenantScimGroupDirectory } from "./tenant-scim-group-directory.js";
export { installTenantScimGroupSchemaV1 } from "./migrations/20261120080100_tenant_scim_groups.migration.js";
