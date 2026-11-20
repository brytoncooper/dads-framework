import type { Identity } from "../identity-types.js";

export type ImpersonationScope = {
  readonly tenantId: string;
  readonly effectiveAccountId: string;
};

export type ImpersonationGrant = ImpersonationScope & {
  readonly id: string;
  readonly staffAccountId: string;
  readonly expiresAtMs: number;
};

export type ImpersonationStoredGrant = ImpersonationGrant & {
  readonly staffSessionId: string;
};

export type ImpersonationStore = {
  /** Insert a new immutable grant and its audit event atomically. */
  readonly insert: (
    grant: ImpersonationStoredGrant,
    event: ImpersonationAuditEvent,
  ) => Promise<void>;
  /** Read from storage that immediately reflects successful removal. */
  readonly read: (id: string) => Promise<ImpersonationStoredGrant | null>;
  /** Remove the grant and write its audit event atomically. Return false if absent. */
  readonly remove: (
    id: string,
    event: ImpersonationAuditEvent,
  ) => Promise<boolean>;
};

export type ImpersonationAction = "start" | "use" | "stop" | "revoke";
export type ImpersonationAuditEvent = {
  readonly action: ImpersonationAction;
  readonly outcome: "authorized" | "denied" | "error";
  readonly actorAccountId: string | null;
  readonly staffAccountId: string | null;
  readonly effectiveAccountId: string | null;
  readonly tenantId: string | null;
  readonly grantId: string | null;
  readonly occurredAtMs: number;
};

export type ImpersonationOptions = {
  readonly identity: Pick<Identity, "readSession">;
  readonly store: ImpersonationStore;
  /** Check current staff permissions and target membership in this tenant. */
  readonly authorize: (
    input: ImpersonationScope & {
      readonly action: "start" | "use" | "revoke";
      readonly actorAccountId: string;
      readonly staffAccountId: string;
    },
  ) => Promise<boolean>;
  readonly writeAudit: (event: ImpersonationAuditEvent) => Promise<void>;
  /** Lifetime in milliseconds, capped by the authenticated session expiry. */
  readonly lifetimeMs: number;
  readonly now?: () => number;
};

export type Impersonation = {
  readonly start: (
    headers: Headers,
    scope: ImpersonationScope,
  ) => Promise<ImpersonationGrant | null>;
  readonly use: (
    headers: Headers,
    input: { readonly grantId: string; readonly tenantId: string },
  ) => Promise<ImpersonationGrant | null>;
  readonly stop: (headers: Headers, grantId: string) => Promise<boolean>;
  readonly revoke: (headers: Headers, grantId: string) => Promise<boolean>;
};
