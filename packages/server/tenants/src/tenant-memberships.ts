import { and, eq } from "drizzle-orm";

import { membershipFact } from "./membership-facts.js";
import {
  assignableTenantRoleSchema,
  type TenantId,
  type TenantRole,
} from "./tenant-access.js";
import { tenantMembership } from "./tenant-tables.js";
import {
  accountSubject,
  checkTenantPermission,
  TenantUnavailableError,
  tenantTransaction,
  type TenantsOptions,
} from "./tenant-transaction.js";

export type TenantMembership = typeof tenantMembership.$inferSelect;

export class TenantMemberships {
  constructor(private readonly options: TenantsOptions) {}

  roster(
    actorId: string,
    tenantId: TenantId,
  ): Promise<readonly TenantMembership[]> {
    const actor = accountSubject(this.options, actorId);
    return tenantTransaction(this.options, async (tx) => {
      if (
        !(await checkTenantPermission(
          this.options,
          tx,
          actor,
          tenantId,
          "manage_members",
        ))
      )
        throw new TenantUnavailableError();
      return tx
        .select()
        .from(tenantMembership)
        .where(eq(tenantMembership.tenantId, tenantId))
        .orderBy(tenantMembership.accountId);
    });
  }

  /** Owners may assign admin or member roles. The creating owner remains an owner. */
  changeRole(
    actorId: string,
    tenantId: TenantId,
    accountId: string,
    role: Exclude<TenantRole, "owner">,
  ): Promise<void> {
    const actor = accountSubject(this.options, actorId);
    const target = accountSubject(this.options, accountId);
    const assignable = assignableTenantRoleSchema.safeParse(role);
    if (!assignable.success) throw new TenantUnavailableError();
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
      const match = memberKey(tenantId, target.id);
      const [member] = await tx
        .select()
        .from(tenantMembership)
        .where(match)
        .for("update");
      if (member === undefined || member.role === "owner")
        throw new TenantUnavailableError();
      if (member.role === assignable.data) return;
      await tx
        .update(tenantMembership)
        .set({ role: assignable.data })
        .where(match);
      await this.options.changes.enqueue(
        [
          membershipFact(
            this.options,
            tenantId,
            target.id,
            member.role,
            "DELETE",
          ),
          membershipFact(
            this.options,
            tenantId,
            target.id,
            assignable.data,
            "WRITE",
          ),
        ],
        tx,
      );
    });
  }

  removeMember(
    actorId: string,
    tenantId: TenantId,
    accountId: string,
  ): Promise<void> {
    const actor = accountSubject(this.options, actorId);
    const target = accountSubject(this.options, accountId);
    return tenantTransaction(this.options, async (tx) => {
      const canManage = await checkTenantPermission(
        this.options,
        tx,
        actor,
        tenantId,
        "manage_members",
      );
      if (!canManage) throw new TenantUnavailableError();
      const match = memberKey(tenantId, target.id);
      const [member] = await tx
        .select()
        .from(tenantMembership)
        .where(match)
        .for("update");
      if (member === undefined || member.role === "owner")
        throw new TenantUnavailableError();
      if (
        member.role === "admin" &&
        !(await checkTenantPermission(
          this.options,
          tx,
          actor,
          tenantId,
          "manage_tenant",
        ))
      ) {
        throw new TenantUnavailableError();
      }
      await tx.delete(tenantMembership).where(match);
      await this.options.changes.enqueue(
        [
          membershipFact(
            this.options,
            tenantId,
            target.id,
            member.role,
            "DELETE",
          ),
        ],
        tx,
      );
    });
  }
}

function memberKey(tenantId: TenantId, accountId: string) {
  return and(
    eq(tenantMembership.tenantId, tenantId),
    eq(tenantMembership.accountId, accountId),
  );
}
