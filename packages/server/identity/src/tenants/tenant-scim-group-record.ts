import type {
  ScimGroup,
  ScimGroupData,
  ScimGroupQuery,
} from "../scim/index.js";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { TenantId } from "./tenant-access.js";
import {
  tenantScimGroup,
  tenantScimGroupMember,
} from "./tenant-scim-group-tables.js";
import type { TenantTransaction } from "./tenant-transaction.js";

type GroupRow = typeof tenantScimGroup.$inferSelect;

export function scimGroupValues(data: ScimGroupData) {
  return {
    displayName: data.displayName,
    displayNameKey: data.displayName.toLowerCase(),
    externalId: data.externalId ?? null,
  };
}

export function scimGroupRecord(
  row: GroupRow,
  memberIds: readonly string[],
): ScimGroup {
  return {
    displayName: row.displayName,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    members: [...memberIds].sort().map((value) => ({ value })),
    id: row.id,
    created: row.createdAt.toISOString(),
    lastModified: row.modifiedAt.toISOString(),
  };
}

export async function loadScimGroupMembers(
  tx: TenantTransaction,
  tenantId: TenantId,
  groupIds: readonly string[],
) {
  const members = new Map<string, string[]>();
  if (groupIds.length === 0) return members;
  const rows = await tx
    .select()
    .from(tenantScimGroupMember)
    .where(
      and(
        eq(tenantScimGroupMember.tenantId, tenantId),
        inArray(tenantScimGroupMember.groupId, groupIds),
      ),
    );
  for (const row of rows) {
    const group = members.get(row.groupId) ?? [];
    group.push(row.userId);
    members.set(row.groupId, group);
  }
  return members;
}

export function scimGroupFilter(filter: ScimGroupQuery["filter"]) {
  if (filter === undefined) return undefined;
  switch (filter.attribute) {
    case "id":
      return sql`${tenantScimGroup.id}::text = ${filter.value}`;
    case "displayName":
      return eq(tenantScimGroup.displayNameKey, filter.value.toLowerCase());
    case "externalId":
      return eq(tenantScimGroup.externalId, filter.value);
  }
}
