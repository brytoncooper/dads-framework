import { inArray } from "drizzle-orm";

import { tenantIdSchema, type TenantId } from "./tenant-access.js";
import { tenantTable } from "./tenant-tables.js";
import type { TenantDatabase } from "./tenant-transaction.js";

/** Use only behind platform authorization, such as flag management. */
export function createTenantDirectory(database: Pick<TenantDatabase, "select">) {
  return {
    async findActiveTenants(ids: readonly string[]) {
      const accepted: TenantId[] = [];
      for (const id of ids) {
        const parsed = tenantIdSchema.safeParse(id);
        if (parsed.success) accepted.push(parsed.data);
      }
      if (accepted.length === 0) return [];
      return database.select().from(tenantTable).where(inArray(tenantTable.id, accepted)).orderBy(tenantTable.id);
    },
  };
}

/** Configure these tables after installing the generic audit trigger function. */
export const tenantAuditConfiguration = {
  tables: {
    tenant: { keyColumns: ["id"], scopeColumns: { tenant_id: "id" } },
    tenant_membership: {
      keyColumns: ["tenant_id", "account_id"],
      scopeColumns: { tenant_id: "tenant_id" },
    },
  },
  excludeTables: ["tenant_invitation", "tenant_scim_user", "tenant_scim_group", "tenant_scim_group_member"],
};
