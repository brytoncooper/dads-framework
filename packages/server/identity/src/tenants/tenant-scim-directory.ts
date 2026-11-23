import { randomUUID } from "node:crypto";
import type { ScimDirectory } from "../scim/index.js";
import { isUniqueViolation } from "@dads-framework/postgres";
import { and, count, eq } from "drizzle-orm";

import {
  lockScimGroupMembershipChanges,
  removeUserFromScimGroups,
} from "./tenant-scim-group-members.js";
import { tenantIdSchema } from "./tenant-access.js";
import {
  liveScimUser,
  revokeScimManagedMembership,
  scimIdSchema,
} from "./tenant-scim-membership.js";
import {
  scimUserData,
  scimUserFilter,
  scimUserRecord,
  scimUserValues,
} from "./tenant-scim-record.js";
import { tenantScimUser } from "./tenant-scim-table.js";
import { tenantTable } from "./tenant-tables.js";
import {
  TenantUnavailableError,
  type TenantsOptions,
} from "./tenant-transaction.js";

/** Use behind tenant-scoped SCIM authentication, with synchronous Postgres access changes. */
export function createTenantScimDirectory(
  options: TenantsOptions,
): ScimDirectory {
  const now = options.now ?? (() => new Date());
  const { database } = options;

  return {
    async list(scope, query) {
      const tenantId = tenantIdSchema.safeParse(scope);
      if (!tenantId.success) return { users: [], totalResults: 0 };
      const scoped = and(
        liveScimUser(tenantId.data),
        scimUserFilter(query.filter),
      );
      return database.transaction(
        async (tx) => {
          const [result] = await tx
            .select({ total: count() })
            .from(tenantScimUser)
            .where(scoped);
          const totalResults = result?.total ?? 0;
          if (query.count === 0 || query.startIndex > totalResults)
            return { users: [], totalResults };
          const rows = await tx
            .select()
            .from(tenantScimUser)
            .where(scoped)
            .orderBy(tenantScimUser.id)
            .limit(query.count)
            .offset(query.startIndex - 1);
          return { users: rows.map(scimUserRecord), totalResults };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async get(scope, identifier) {
      const tenantId = tenantIdSchema.safeParse(scope);
      const id = scimIdSchema.safeParse(identifier);
      if (!tenantId.success || !id.success) return null;
      const [user] = await database
        .select()
        .from(tenantScimUser)
        .where(liveScimUser(tenantId.data, id.data));
      return user === undefined ? null : scimUserRecord(user);
    },

    async create(scope, data) {
      const tenantId = tenantIdSchema.safeParse(scope);
      if (!tenantId.success) throw new TenantUnavailableError();
      return scimConflict(() =>
        database.transaction(async (tx) => {
          const [tenant] = await tx
            .select({ id: tenantTable.id })
            .from(tenantTable)
            .where(eq(tenantTable.id, tenantId.data))
            .for("key share");
          if (tenant === undefined) throw new TenantUnavailableError();
          const time = now();
          const [user] = await tx
            .insert(tenantScimUser)
            .values({
              ...scimUserValues(data),
              id: randomUUID(),
              tenantId: tenant.id,
              createdAt: time,
              modifiedAt: time,
            })
            .returning();
          if (user === undefined)
            throw new Error("SCIM user insert returned no row");
          return scimUserRecord(user);
        }),
      );
    },

    async update(scope, identifier, change) {
      const tenantId = tenantIdSchema.safeParse(scope);
      const id = scimIdSchema.safeParse(identifier);
      if (!tenantId.success || !id.success) return null;
      const match = liveScimUser(tenantId.data, id.data);
      return scimConflict(() =>
        database.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(tenantScimUser)
            .where(match)
            .for("update");
          if (row === undefined) return null;
          const data = change(scimUserData(row));
          const [updated] = await tx
            .update(tenantScimUser)
            .set({ ...scimUserValues(data), modifiedAt: now() })
            .where(match)
            .returning();
          if (updated === undefined)
            throw new Error("SCIM user update returned no row");
          if (!data.active)
            await revokeScimManagedMembership(
              options,
              tx,
              row.tenantId,
              row.accountId,
            );
          return scimUserRecord(updated);
        }),
      );
    },

    async delete(scope, identifier) {
      const tenantId = tenantIdSchema.safeParse(scope);
      const id = scimIdSchema.safeParse(identifier);
      if (!tenantId.success || !id.success) return false;
      return database.transaction(async (tx) => {
        if (!(await lockScimGroupMembershipChanges(tx, tenantId.data)))
          return false;
        const time = now();
        const [deleted] = await tx
          .update(tenantScimUser)
          .set({
            ...scimUserValues({ userName: id.data, active: false }),
            modifiedAt: time,
            deletedAt: time,
          })
          .where(liveScimUser(tenantId.data, id.data))
          .returning();
        if (deleted === undefined) return false;
        await removeUserFromScimGroups(tx, deleted.tenantId, deleted.id, time);
        await revokeScimManagedMembership(
          options,
          tx,
          deleted.tenantId,
          deleted.accountId,
        );
        return true;
      });
    },
  };
}

async function scimConflict<Result>(
  operation: () => Promise<Result>,
): Promise<Result | "conflict"> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) return "conflict";
    throw error;
  }
}
