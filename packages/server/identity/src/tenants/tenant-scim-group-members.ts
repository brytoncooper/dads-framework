import { and, eq, inArray } from "drizzle-orm";

import type { TenantId } from "./tenant-access.js";
import { tenantScimGroup, tenantScimGroupMember } from "./tenant-scim-group-tables.js";
import { liveScimUser, scimIdSchema } from "./tenant-scim-membership.js";
import { tenantScimUser } from "./tenant-scim-table.js";
import { tenantTable } from "./tenant-tables.js";
import type { TenantTransaction } from "./tenant-transaction.js";

/** Serialize group member changes with user tombstones in this tenant. */
export async function lockScimGroupMembershipChanges(tx: TenantTransaction, tenantId: TenantId) {
  const [tenant] = await tx
    .select({ id: tenantTable.id })
    .from(tenantTable)
    .where(eq(tenantTable.id, tenantId))
    .for("no key update");
  return tenant !== undefined;
}

export async function validateScimGroupMembers(
  tx: TenantTransaction,
  tenantId: TenantId,
  userIds: readonly string[],
): Promise<boolean> {
  if (userIds.length === 0) return true;
  if (userIds.some((id) => !scimIdSchema.safeParse(id).success)) return false;
  const users = await tx
    .select({ id: tenantScimUser.id })
    .from(tenantScimUser)
    .where(and(liveScimUser(tenantId), inArray(tenantScimUser.id, userIds)));
  return users.length === userIds.length;
}

export async function replaceScimGroupMembers(
  tx: TenantTransaction,
  tenantId: TenantId,
  groupId: string,
  userIds: readonly string[],
) {
  await tx
    .delete(tenantScimGroupMember)
    .where(and(eq(tenantScimGroupMember.tenantId, tenantId), eq(tenantScimGroupMember.groupId, groupId)));
  if (userIds.length > 0)
    await tx.insert(tenantScimGroupMember).values(userIds.map((userId) => ({ tenantId, groupId, userId })));
}

export async function removeUserFromScimGroups(
  tx: TenantTransaction,
  tenantId: TenantId,
  userId: string,
  modifiedAt: Date,
) {
  const links = await tx
    .delete(tenantScimGroupMember)
    .where(and(eq(tenantScimGroupMember.tenantId, tenantId), eq(tenantScimGroupMember.userId, userId)))
    .returning({ groupId: tenantScimGroupMember.groupId });
  if (links.length === 0) return;
  await tx
    .update(tenantScimGroup)
    .set({ modifiedAt })
    .where(
      and(
        eq(tenantScimGroup.tenantId, tenantId),
        inArray(
          tenantScimGroup.id,
          links.map(({ groupId }) => groupId),
        ),
      ),
    );
}
