import {
  type Authorization,
  type EnqueueAccessChanges,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import type { DrizzleHandle } from "@dads-framework/postgres";

import type { TenantAccess, TenantId } from "./tenant-access.js";

export type TenantTransaction = Parameters<
  Parameters<DrizzleHandle["transaction"]>[0]
>[0];
export type TenantDatabase = Pick<DrizzleHandle, "select" | "transaction">;

export type TenantsOptions = {
  readonly database: TenantDatabase;
  readonly access: TenantAccess;
  /** Resolves and writes facts through the same primary database transaction. */
  readonly authorizationAt: (
    transaction: TenantTransaction,
  ) => Pick<Authorization, "check" | "lookupResources">;
  readonly changes: Pick<EnqueueAccessChanges<TenantTransaction>, "enqueue">;
  readonly now?: () => Date;
};

export class TenantUnavailableError extends Error {
  constructor() {
    super("Tenant is unavailable");
    this.name = "TenantUnavailableError";
  }
}

export function accountSubject(
  options: TenantsOptions,
  accountId: string,
): SubjectRef {
  const id = options.access.account.idSchema.parse(accountId);
  return { type: options.access.account.wireName, id };
}

export async function checkTenantPermission(
  options: TenantsOptions,
  tx: TenantTransaction,
  identity: SubjectRef,
  tenantId: TenantId,
  permission: keyof TenantAccess["tenant"]["permissions"],
): Promise<boolean> {
  const token = options.access.tenant.permissions[permission];
  return options.authorizationAt(tx).check({
    subject: identity,
    resource: { type: token.entityWireName, id: tenantId },
    permission: token.permissionName,
  });
}

export function tenantTransaction<Result>(
  options: TenantsOptions,
  work: (tx: TenantTransaction) => Promise<Result>,
): Promise<Result> {
  return options.database.transaction(work, { isolationLevel: "serializable" });
}
