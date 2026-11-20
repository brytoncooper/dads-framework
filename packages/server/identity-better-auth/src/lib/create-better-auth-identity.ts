import type { Identity } from "@dads-framework/identity";
import { createAccountInvitations } from "./account-invitations.js";
import { configureBetterAuth } from "./configure-better-auth.js";
import { identityEmailSender } from "./identity-email.js";
import { createIdentityHandler } from "./identity-handler.js";
import {
  type BetterAuthIdentityOptions,
  validatedOrigin,
} from "./identity-options.js";

/** Bind identity to the application's Postgres pool and mail queue. */
export function createBetterAuthIdentity(
  options: BetterAuthIdentityOptions,
): Identity {
  if (options.secret.length < 32)
    throw new Error("Identity requires a secret of at least 32 characters.");
  const origin = validatedOrigin(options.baseUrl);
  const sendEmail = identityEmailSender(options);
  const vendor = configureBetterAuth(options, origin, sendEmail);
  const invitations = createAccountInvitations(options, origin, sendEmail);
  const readSession: Identity["readSession"] = async (headers) => {
    const current = await vendor.api.getSession({ headers });
    if (current === null) return null;
    const { id, email, emailVerified } = current.user;
    if (!emailVerified) return null;
    return {
      account: { id, email, emailVerified },
      expiresAt: current.session.expiresAt,
    };
  };

  return {
    handle: createIdentityHandler(vendor, invitations, origin, readSession),
    readSession,
  };
}
