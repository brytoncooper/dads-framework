import type { Identity } from "../../index.js";
import { createAccountInvitations } from "./account-invitations.js";
import { configureBetterAuth } from "./configure-better-auth.js";
import { type EnterpriseSsoProvider, verifyEnterpriseProviders } from "./enterprise-options.js";
import { createEnterpriseRoutes } from "./enterprise-routes.js";
import { createIdentitySessionReaders, type EnterpriseBetterAuthIdentity } from "./identity-session-readers.js";
import { identityEmailSender } from "./identity-email.js";
import { createIdentityHandler } from "./identity-handler.js";
import { type BetterAuthIdentityOptions, validatedOrigin } from "./identity-options.js";

/** Bind identity to the application's Postgres pool and mail queue. */
export function createBetterAuthIdentity(options: BetterAuthIdentityOptions): Identity {
  return createIdentity(options, validatedIdentityOrigin(options), []);
}

/** Bind deployment-administered, DNS-verified tenant SSO providers. */
export async function createEnterpriseBetterAuthIdentity(
  options: BetterAuthIdentityOptions,
  configured: readonly EnterpriseSsoProvider[],
): Promise<EnterpriseBetterAuthIdentity> {
  const origin = validatedIdentityOrigin(options);
  const providers = await verifyEnterpriseProviders(configured, options.secret, origin);
  return createIdentity(options, origin, providers);
}

function validatedIdentityOrigin(options: BetterAuthIdentityOptions): string {
  if (options.secret.length < 32) throw new Error("Identity requires a secret of at least 32 characters.");
  return validatedOrigin(options.baseUrl);
}

function createIdentity(
  options: BetterAuthIdentityOptions,
  origin: string,
  providers: readonly EnterpriseSsoProvider[],
): EnterpriseBetterAuthIdentity {
  const sendEmail = identityEmailSender(options);
  const vendor = configureBetterAuth(options, origin, sendEmail, providers);
  const invitations = createAccountInvitations(options, origin, sendEmail);
  const readers = createIdentitySessionReaders(vendor, providers);
  const enterpriseRoutes =
    providers.length === 0 ? undefined : createEnterpriseRoutes(providers, origin, options.secret, vendor.handler);
  return {
    handle: createIdentityHandler(vendor, invitations, origin, readers.readSession, enterpriseRoutes),
    ...readers,
  };
}
