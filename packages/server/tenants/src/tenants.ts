import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { membershipFact } from "./membership-facts.js";
import { tenantIdSchema, type TenantId } from "./tenant-access.js";
import { TenantInvitations } from "./tenant-invitations.js";
import { TenantMemberships } from "./tenant-memberships.js";
import { tenantMembership, tenantTable } from "./tenant-tables.js";
import {
  accountSubject,
  checkTenantPermission,
  TenantUnavailableError,
  tenantTransaction,
  type TenantsOptions,
} from "./tenant-transaction.js";

const tenantName = z.string().trim().min(1).max(120);

export type TenantRecord = typeof tenantTable.$inferSelect;

export type TenantContext = {
  readonly tenant: TenantRecord;
  readonly audience: { readonly kind: "tenant"; readonly tenantId: TenantId };
  readonly auditScope: {
    readonly kind: "application";
    readonly values: { readonly tenant_id: TenantId };
  };
};

export class Tenants {
  readonly invitations: TenantInvitations;
  readonly memberships: TenantMemberships;

  constructor(private readonly options: TenantsOptions) {
    this.invitations = new TenantInvitations(options);
    this.memberships = new TenantMemberships(options);
  }

  create(actorId: string, name: string): Promise<TenantRecord> {
    const actor = accountSubject(this.options, actorId);
    const tenant = {
      id: tenantIdSchema.parse(randomUUID()),
      name: tenantName.parse(name),
    };
    return tenantTransaction(this.options, async (tx) => {
      await tx.insert(tenantTable).values(tenant);
      await tx
        .insert(tenantMembership)
        .values({ tenantId: tenant.id, accountId: actor.id, role: "owner" });
      await this.options.changes.enqueue(
        [membershipFact(this.options, tenant.id, actor.id, "owner", "WRITE")],
        tx,
      );
      return tenant;
    });
  }

  list(actorId: string): Promise<readonly TenantRecord[]> {
    const subject = accountSubject(this.options, actorId);
    const view = this.options.access.tenant.permissions.view;
    return tenantTransaction(this.options, async (tx) => {
      const visible = await this.options.authorizationAt(tx).lookupResources({
        subject,
        resourceType: view.entityWireName,
        permission: view.permissionName,
      });
      if (visible.length === 0) return [];
      const ids = visible.map((id) => tenantIdSchema.parse(id));
      return tx
        .select()
        .from(tenantTable)
        .where(inArray(tenantTable.id, ids))
        .orderBy(tenantTable.id);
    });
  }

  context(actorId: string, tenantId: TenantId): Promise<TenantContext> {
    const actor = accountSubject(this.options, actorId);
    return tenantTransaction(this.options, async (tx) => {
      if (
        !(await checkTenantPermission(
          this.options,
          tx,
          actor,
          tenantId,
          "view",
        ))
      )
        throw new TenantUnavailableError();
      const [tenant] = await tx
        .select()
        .from(tenantTable)
        .where(eq(tenantTable.id, tenantId));
      if (tenant === undefined) throw new TenantUnavailableError();
      return {
        tenant,
        audience: { kind: "tenant", tenantId },
        auditScope: { kind: "application", values: { tenant_id: tenantId } },
      };
    });
  }

  rename(
    actorId: string,
    tenantId: TenantId,
    name: string,
  ): Promise<TenantRecord> {
    const actor = accountSubject(this.options, actorId);
    const checkedName = tenantName.parse(name);
    return tenantTransaction(this.options, async (tx) => {
      if (
        !(await checkTenantPermission(
          this.options,
          tx,
          actor,
          tenantId,
          "manage_tenant",
        ))
      )
        throw new TenantUnavailableError();
      const [changed] = await tx
        .update(tenantTable)
        .set({ name: checkedName })
        .where(eq(tenantTable.id, tenantId))
        .returning();
      if (changed === undefined) throw new TenantUnavailableError();
      return changed;
    });
  }
}
