import type { Identity, IdentitySession } from "@dads-framework/identity";
import type { configureBetterAuth } from "./configure-better-auth.js";
import {
  enterpriseProviderBinding,
  type EnterpriseSsoProvider,
} from "./enterprise-options.js";
import { forEmail } from "./enterprise-plugin.js";

export type EnterpriseSsoSession = IdentitySession & {
  readonly providerId: string;
  readonly tenantId: string;
  readonly authenticatedAt: Date;
};

export type EnterpriseBetterAuthIdentity = Identity & {
  /** Authenticate the user for a tenant. Applications still authorize membership separately. */
  readonly readTenantSession: (
    headers: Headers,
    tenantId: string,
  ) => Promise<IdentitySession | null>;
  /** Read a session authenticated via this tenant's configured SSO provider. */
  readonly readEnterpriseSession: (
    headers: Headers,
    tenantId: string,
    maxAgeMs?: number,
  ) => Promise<EnterpriseSsoSession | null>;
};

type BetterAuth = ReturnType<typeof configureBetterAuth>;

export function createIdentitySessionReaders(
  vendor: BetterAuth,
  providers: readonly EnterpriseSsoProvider[],
): Omit<EnterpriseBetterAuthIdentity, "handle"> {
  async function readCurrent(headers: Headers) {
    const current = await vendor.api.getSession({ headers });
    if (current === null || !current.user.emailVerified) return null;
    const provider = forEmail(providers, current.user.email);
    const sessionBinding =
      "ssoProviderBinding" in current.session
        ? current.session.ssoProviderBinding
        : undefined;
    const hasProviderSession = sessionMatchesProvider(sessionBinding, provider);
    if (
      !hasProviderSession &&
      (provider?.mode === "required" || sessionBinding != null)
    )
      return null;
    return { current, provider: hasProviderSession ? provider : undefined };
  }

  const readSession: Identity["readSession"] = async (headers) => {
    const context = await readCurrent(headers);
    return context === null ? null : identityView(context.current);
  };

  const readEnterpriseSession: EnterpriseBetterAuthIdentity["readEnterpriseSession"] =
    async (headers, tenantId, maxAgeMs) => {
      const context = await readCurrent(headers);
      if (context === null || context.provider?.tenantId !== tenantId)
        return null;
      const authenticatedAt = context.current.session.createdAt;
      if (!withinAge(authenticatedAt, maxAgeMs)) return null;
      return {
        ...identityView(context.current),
        providerId: context.provider.id,
        tenantId,
        authenticatedAt,
      };
    };

  const readTenantSession: EnterpriseBetterAuthIdentity["readTenantSession"] =
    async (headers, tenantId) => {
      if (
        !providers.some(
          (provider) =>
            provider.tenantId === tenantId && provider.mode === "required",
        )
      )
        return readSession(headers);
      return await readEnterpriseSession(headers, tenantId);
    };

  return { readSession, readEnterpriseSession, readTenantSession };
}

function sessionMatchesProvider(
  binding: unknown,
  provider: EnterpriseSsoProvider | undefined,
): boolean {
  return (
    typeof binding === "string" &&
    provider !== undefined &&
    binding === enterpriseProviderBinding(provider)
  );
}

function withinAge(authenticatedAt: Date, maxAgeMs?: number): boolean {
  const age = Date.now() - authenticatedAt.getTime();
  return (
    maxAgeMs === undefined ||
    (Number.isFinite(maxAgeMs) && age >= 0 && age <= maxAgeMs)
  );
}

function identityView(current: {
  user: IdentitySession["account"];
  session: { id: string; expiresAt: Date };
}): IdentitySession {
  const { id, email, emailVerified } = current.user;
  return {
    account: { id, email, emailVerified },
    expiresAt: current.session.expiresAt,
    sessionId: current.session.id,
  };
}
