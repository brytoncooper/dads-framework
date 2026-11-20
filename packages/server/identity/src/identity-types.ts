/** Account identity proven by a server-side session lookup. */
export type IdentityAccount = {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
};

export type IdentitySession = {
  readonly account: IdentityAccount;
  readonly expiresAt: Date;
};

/** Mount the handler at the application's identity route boundary. */
export type Identity = {
  readonly handle: (request: Request) => Promise<Response>;
  readonly readSession: (headers: Headers) => Promise<IdentitySession | null>;
};

export type IdentityEmail = {
  readonly kind: "verify-email" | "reset-password" | "account-invitation";
  readonly to: string;
  readonly url: string;
};

/** Enqueue confidential messages through the application's mail transport. */
export type EnqueueIdentityEmail = (message: IdentityEmail) => Promise<void>;
