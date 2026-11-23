import { isUniqueViolation } from "@dads-framework/postgres";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { membershipFact } from "./membership-facts.js";
import { tenantIdSchema, type TenantId } from "./tenant-access.js";
import { tenantScimUser } from "./tenant-scim-table.js";
import { tenantMembership, tenantMembershipKey } from "./tenant-tables.js";
import {
  accountSubject,
  checkTenantPermission,
  TenantUnavailableError,
  tenantTransaction,
  type TenantTransaction,
  type TenantsOptions,
} from "./tenant-transaction.js";

export const scimIdSchema = z.uuid().refine((id) => id === id.toLowerCase());

export function liveScimUser(tenantId: TenantId, id?: string) {
  return and(
    eq(tenantScimUser.tenantId, tenantId),
    isNull(tenantScimUser.deletedAt),
    id === undefined ? undefined : eq(tenantScimUser.id, id),
  );
}

export async function bindTenantScimUser(
  options: TenantsOptions,
  actorId: string,
  tenantId: TenantId,
  userId: string,
  accountId: string,
): Promise<void> {
  const actor = accountSubject(options, actorId);
  const target = accountSubject(options, accountId);
  const tenant = tenantIdSchema.parse(tenantId);
  const id = scimIdSchema.parse(userId);
  try {
    await tenantTransaction(options, async (tx) => {
      if (!(await checkTenantPermission(options, tx, actor, tenant, "manage_tenant")))
        throw new TenantUnavailableError();
      const userKey = liveScimUser(tenant, id);
      const [user] = await tx.select().from(tenantScimUser).where(userKey).for("update");
      if (user === undefined || !user.active || (user.accountId !== null && user.accountId !== target.id))
        throw new TenantUnavailableError();
      const [member] = await tx
        .select()
        .from(tenantMembership)
        .where(tenantMembershipKey(tenant, target.id))
        .for("update");
      if (member?.role === "owner") throw new TenantUnavailableError();
      if (member === undefined) await releaseDeletedScimBinding(tx, tenant, target.id);
      await tx.update(tenantScimUser).set({ accountId: target.id }).where(userKey);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new TenantUnavailableError();
    throw error;
  }
}

async function releaseDeletedScimBinding(tx: TenantTransaction, tenantId: TenantId, accountId: string): Promise<void> {
  const [previous] = await tx
    .update(tenantScimUser)
    .set({ accountId: null })
    .where(and(scimAccountKey(tenantId, accountId), isNotNull(tenantScimUser.deletedAt)))
    .returning({ id: tenantScimUser.id });
  if (previous === undefined) throw new TenantUnavailableError();
}

/** Hold the directory row through the invitation's membership write. */
export async function lockScimAccountBinding(tx: TenantTransaction, tenantId: TenantId, accountId: string) {
  const [user] = await tx
    .select({ active: tenantScimUser.active })
    .from(tenantScimUser)
    .where(scimAccountKey(tenantId, accountId))
    .for("update");
  return user;
}

export async function revokeScimManagedMembership(
  options: TenantsOptions,
  tx: TenantTransaction,
  tenantId: TenantId,
  accountId: string | null,
): Promise<void> {
  if (accountId === null) return;
  const [member] = await tx.delete(tenantMembership).where(tenantMembershipKey(tenantId, accountId)).returning();
  if (member === undefined) return;
  if (member.role === "owner") throw new TenantUnavailableError();
  await options.changes.enqueue([membershipFact(options, tenantId, accountId, member.role, "DELETE")], tx);
}

function scimAccountKey(tenantId: TenantId, accountId: string) {
  return and(eq(tenantScimUser.tenantId, tenantId), eq(tenantScimUser.accountId, accountId));
}
