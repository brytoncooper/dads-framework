import type { EnqueueIdentityEmail, IdentityAccount } from "../../index.js";
import type { PostgresPool } from "kysely";

export const IDENTITY_PATH = "/api/auth";

export type BetterAuthIdentityOptions = {
  readonly database: { readonly pool: PostgresPool };
  readonly baseUrl: string;
  readonly secret: string;
  readonly enqueueEmail: EnqueueIdentityEmail;
  readonly canInvite: (account: IdentityAccount) => Promise<boolean>;
  readonly onEmailError?: () => void;
};

export function validatedOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Identity requires HTTPS or a loopback HTTP origin.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Identity requires a bare origin.");
  }
  return url.origin;
}
