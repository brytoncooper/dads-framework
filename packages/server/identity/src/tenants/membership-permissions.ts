import { and, eq } from "drizzle-orm";

import type { TenantId } from "./tenant-access.js";
import { tenantMembership } from "./tenant-tables.js";
import {
  accountSubject,
  checkTenantPermission,
  TenantUnavailableError,
  tenantTransaction,
  type TenantsOptions,
} from "./tenant-transaction.js";

/** Inspect a member of this tenant using a single authorized database snapshot. */
export function inspectMemberPermissions(
  options: TenantsOptions,
  actorId: string,
  tenantId: TenantId,
  accountId: string,
) {
  const actor = accountSubject(options, actorId);
  const member = accountSubject(options, accountId);
  return tenantTransaction(options, async (tx) => {
    if (!(await checkTenantPermission(options, tx, actor, tenantId, "manage_members"))) {
      throw new TenantUnavailableError();
    }

    const [membership] = await tx
      .select({ role: tenantMembership.role })
      .from(tenantMembership)
      .where(and(eq(tenantMembership.tenantId, tenantId), eq(tenantMembership.accountId, member.id)));
    if (membership === undefined) throw new TenantUnavailableError();

    const view = await checkTenantPermission(options, tx, member, tenantId, "view");
    const manageMembers = await checkTenantPermission(options, tx, member, tenantId, "manage_members");
    const manageTenant = await checkTenantPermission(options, tx, member, tenantId, "manage_tenant");
    return { role: membership.role, view, manageMembers, manageTenant };
  });
}
