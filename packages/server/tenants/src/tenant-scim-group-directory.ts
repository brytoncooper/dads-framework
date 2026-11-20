import { randomUUID } from "node:crypto";
import type {
  ScimGroupData,
  ScimGroupDirectory,
} from "@dads-framework/identity/scim";
import { and, count, eq } from "drizzle-orm";

import { tenantIdSchema, type TenantId } from "./tenant-access.js";
import {
  lockScimGroupMembershipChanges,
  replaceScimGroupMembers,
  validateScimGroupMembers,
} from "./tenant-scim-group-members.js";
import {
  loadScimGroupMembers,
  scimGroupFilter,
  scimGroupRecord,
  scimGroupValues,
} from "./tenant-scim-group-record.js";
import { tenantScimGroup } from "./tenant-scim-group-tables.js";
import { scimIdSchema } from "./tenant-scim-membership.js";
import {
  TenantUnavailableError,
  type TenantsOptions,
} from "./tenant-transaction.js";

const groupReadSnapshot = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

/** SCIM group memberships carry directory data only. */
export function createTenantScimGroupDirectory(
  options: Pick<TenantsOptions, "database" | "now">,
): ScimGroupDirectory {
  const { database } = options;
  const now = options.now ?? (() => new Date());

  return {
    async list(scope, query) {
      const tenantId = tenantIdSchema.safeParse(scope);
      if (!tenantId.success) return { groups: [], totalResults: 0 };
      const key = and(
        eq(tenantScimGroup.tenantId, tenantId.data),
        scimGroupFilter(query.filter),
      );
      return database.transaction(async (tx) => {
        const [result] = await tx
          .select({ total: count() })
          .from(tenantScimGroup)
          .where(key);
        const totalResults = result?.total ?? 0;
        if (query.count === 0 || query.startIndex > totalResults)
          return { groups: [], totalResults };
        const rows = await tx
          .select()
          .from(tenantScimGroup)
          .where(key)
          .orderBy(tenantScimGroup.id)
          .limit(query.count)
          .offset(query.startIndex - 1);
        const members = await loadScimGroupMembers(
          tx,
          tenantId.data,
          rows.map((row) => row.id),
        );
        return {
          groups: rows.map((row) =>
            scimGroupRecord(row, members.get(row.id) ?? []),
          ),
          totalResults,
        };
      }, groupReadSnapshot);
    },

    async get(scope, identifier) {
      const tenantId = tenantIdSchema.safeParse(scope);
      const id = scimIdSchema.safeParse(identifier);
      if (!tenantId.success || !id.success) return null;
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(tenantScimGroup)
          .where(groupKey(tenantId.data, id.data));
        if (row === undefined) return null;
        const members = await loadScimGroupMembers(tx, tenantId.data, [
          id.data,
        ]);
        return scimGroupRecord(row, members.get(id.data) ?? []);
      }, groupReadSnapshot);
    },

    async create(scope, data) {
      const tenantId = tenantIdSchema.safeParse(scope);
      if (!tenantId.success) throw new TenantUnavailableError();
      return database.transaction(async (tx) => {
        if (!(await lockScimGroupMembershipChanges(tx, tenantId.data)))
          throw new TenantUnavailableError();
        const userIds = groupUserIds(data);
        if (!(await validateScimGroupMembers(tx, tenantId.data, userIds)))
          return "invalidMember";
        const time = now();
        const [row] = await tx
          .insert(tenantScimGroup)
          .values({
            ...scimGroupValues(data),
            tenantId: tenantId.data,
            id: randomUUID(),
            createdAt: time,
            modifiedAt: time,
          })
          .returning();
        if (row === undefined)
          throw new Error("SCIM group insert returned no row");
        await replaceScimGroupMembers(tx, row.tenantId, row.id, userIds);
        return scimGroupRecord(row, userIds);
      });
    },

    async update(scope, identifier, change) {
      const tenantId = tenantIdSchema.safeParse(scope);
      const id = scimIdSchema.safeParse(identifier);
      if (!tenantId.success || !id.success) return null;
      const key = groupKey(tenantId.data, id.data);
      return database.transaction(async (tx) => {
        if (!(await lockScimGroupMembershipChanges(tx, tenantId.data)))
          return null;
        const [row] = await tx.select().from(tenantScimGroup).where(key);
        if (row === undefined) return null;
        const members = await loadScimGroupMembers(tx, tenantId.data, [
          id.data,
        ]);
        const updated = change(scimGroupRecord(row, members.get(row.id) ?? []));
        const userIds = groupUserIds(updated);
        if (!(await validateScimGroupMembers(tx, tenantId.data, userIds)))
          return "invalidMember";
        const [saved] = await tx
          .update(tenantScimGroup)
          .set({ ...scimGroupValues(updated), modifiedAt: now() })
          .where(key)
          .returning();
        if (saved === undefined)
          throw new Error("SCIM group update returned no row");
        await replaceScimGroupMembers(tx, saved.tenantId, saved.id, userIds);
        return scimGroupRecord(saved, userIds);
      });
    },

    async delete(scope, identifier) {
      const tenantId = tenantIdSchema.safeParse(scope);
      const id = scimIdSchema.safeParse(identifier);
      if (!tenantId.success || !id.success) return false;
      return database.transaction(async (tx) => {
        if (!(await lockScimGroupMembershipChanges(tx, tenantId.data)))
          return false;
        const [deleted] = await tx
          .delete(tenantScimGroup)
          .where(groupKey(tenantId.data, id.data))
          .returning({ id: tenantScimGroup.id });
        return deleted !== undefined;
      });
    },
  };
}

function groupKey(tenantId: TenantId, id: string) {
  return and(
    eq(tenantScimGroup.tenantId, tenantId),
    eq(tenantScimGroup.id, id),
  );
}

function groupUserIds(group: ScimGroupData) {
  return [...new Set(group.members.map((member) => member.value))];
}
