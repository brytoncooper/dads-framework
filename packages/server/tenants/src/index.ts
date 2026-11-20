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

export { installTenantSchemaV1 } from "./migrations/20261120040000_tenants.migration.js";
