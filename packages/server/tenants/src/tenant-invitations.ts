import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { membershipFact } from "./membership-facts.js";
import type { TenantId } from "./tenant-access.js";
import { tenantInvitation, tenantMembership } from "./tenant-tables.js";
import {
  accountSubject,
  checkTenantPermission,
  TenantUnavailableError,
  tenantTransaction,
  type TenantsOptions,
  type TenantTransaction,
} from "./tenant-transaction.js";

const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;
const providerEmail = z.string().trim().toLowerCase().pipe(z.email());
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Authenticated session identity supplied by application composition. */
export type AuthenticatedTenantAccount = {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
};

export class TenantInvitationUnavailableError extends Error {
  constructor() {
    super("Tenant invitation is unavailable");
    this.name = "TenantInvitationUnavailableError";
  }
}

export class TenantInvitations {
  constructor(private readonly options: TenantsOptions) {}

  issue(
    actorId: string,
    tenantId: TenantId,
    email: string,
  ): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const actor = accountSubject(this.options, actorId);
    const recipientEmail = providerEmail.parse(email);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + invitationTtlMs);
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
      await tx.insert(tenantInvitation).values({
        tokenHash: digest(token),
        tenantId,
        recipientEmail,
        issuedBy: actor.id,
        expiresAt,
      });
      return { token, expiresAt };
    });
  }

  accept(
    token: string,
    account: AuthenticatedTenantAccount,
  ): Promise<TenantId> {
    const email = providerEmail.safeParse(account.email);
    if (
      !z.literal(true).safeParse(account.emailVerified).success ||
      !email.success ||
      !tokenPattern.test(token)
    ) {
      return Promise.reject(new TenantInvitationUnavailableError());
    }
    const actor = accountSubject(this.options, account.id);
    return tenantTransaction(this.options, async (tx) => {
      const invitation = await this.lockInvitation(
        tx,
        digest(token),
        email.data,
      );
      const issuer = accountSubject(this.options, invitation.issuedBy);
      await this.lockIssuerMembership(tx, invitation.tenantId, issuer.id);
      if (
        !(await checkTenantPermission(
          this.options,
          tx,
          issuer,
          invitation.tenantId,
          "manage_members",
        ))
      ) {
        throw new TenantInvitationUnavailableError();
      }
      const acceptedAt = this.now();
      if (invitation.expiresAt <= acceptedAt)
        throw new TenantInvitationUnavailableError();
      await this.acceptMembership(tx, invitation.tenantId, actor.id);
      await tx
        .update(tenantInvitation)
        .set({ acceptedAt })
        .where(eq(tenantInvitation.tokenHash, invitation.tokenHash));
      return invitation.tenantId;
    });
  }

  private async lockInvitation(
    tx: TenantTransaction,
    tokenHash: string,
    email: string,
  ) {
    const [invitation] = await tx
      .select()
      .from(tenantInvitation)
      .where(eq(tenantInvitation.tokenHash, tokenHash))
      .for("update");
    if (
      invitation === undefined ||
      invitation.acceptedAt !== null ||
      invitation.expiresAt <= this.now() ||
      invitation.recipientEmail !== email
    ) {
      throw new TenantInvitationUnavailableError();
    }
    return invitation;
  }

  /** Keep the issuer eligible until the grant commits. Role changes lock the same row. */
  private async lockIssuerMembership(
    tx: TenantTransaction,
    tenantId: TenantId,
    accountId: string,
  ): Promise<void> {
    const [member] = await tx
      .select({ accountId: tenantMembership.accountId })
      .from(tenantMembership)
      .where(
        and(
          eq(tenantMembership.tenantId, tenantId),
          eq(tenantMembership.accountId, accountId),
        ),
      )
      .for("share");
    if (member === undefined) throw new TenantInvitationUnavailableError();
  }

  private async acceptMembership(
    tx: TenantTransaction,
    tenantId: TenantId,
    accountId: string,
  ): Promise<void> {
    const [added] = await tx
      .insert(tenantMembership)
      .values({ tenantId, accountId, role: "member" })
      .onConflictDoNothing()
      .returning({ accountId: tenantMembership.accountId });
    if (added === undefined) return;
    await this.options.changes.enqueue(
      [membershipFact(this.options, tenantId, accountId, "member", "WRITE")],
      tx,
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
