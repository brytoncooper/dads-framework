import { createHash, createHmac, X509Certificate } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeIdentityEmail } from "../../index.js";

type ProviderBase = {
  readonly id: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly mode: "optional" | "required";
};

export type EnterpriseSsoProvider = ProviderBase &
  (
    | {
        readonly protocol: "oidc";
        readonly issuer: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly authorizationEndpoint: string;
        readonly tokenEndpoint: string;
        readonly jwksEndpoint: string;
        readonly tokenEndpointAuthentication?:
          "client_secret_basic" | "client_secret_post";
      }
    | {
        readonly protocol: "saml";
        readonly entityId: string;
        readonly signInUrl: string;
        readonly signingCertificate: string;
        readonly emailAttribute?: string;
      }
  );

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

export function enterpriseSsoDomainChallenge(
  secret: string,
  tenantId: string,
  domain: string,
): { name: string; value: string } {
  if (!DOMAIN.test(domain) || !tenantId.trim() || secret.length < 32)
    throw new Error("Invalid enterprise SSO domain challenge configuration.");
  const token = createHmac("sha256", secret)
    .update(JSON.stringify(["dads-sso-domain-v1", tenantId, domain]))
    .digest("base64url");
  return {
    name: `_dads-sso.${domain}`,
    value: `dads-sso-verification=${token}`,
  };
}

export async function verifyEnterpriseProviders(
  configured: readonly EnterpriseSsoProvider[],
  secret: string,
  origin: string,
): Promise<readonly EnterpriseSsoProvider[]> {
  const providers = configured.map((provider) => ({ ...provider }));
  if (providers.length === 0)
    throw new Error("Configure at least one enterprise SSO provider.");
  const ids = new Set<string>();
  const domains = new Set<string>();
  const tenantModes = new Map<string, "optional" | "required">();
  for (const provider of providers) {
    validateProvider(provider, origin);
    if (ids.has(provider.id) || domains.has(provider.domain))
      throw new Error(
        "Enterprise SSO provider IDs and domains must be unique.",
      );
    const tenantMode = tenantModes.get(provider.tenantId);
    if (tenantMode !== undefined && tenantMode !== provider.mode)
      throw new Error(
        "Enterprise SSO providers for a tenant must use the same mode.",
      );
    tenantModes.set(provider.tenantId, provider.mode);
    ids.add(provider.id);
    domains.add(provider.domain);
  }

  await Promise.all(
    providers.map(async ({ tenantId, domain }) => {
      const challenge = enterpriseSsoDomainChallenge(secret, tenantId, domain);
      const records = await resolveTxt(challenge.name).catch(() => []);
      if (!records.some((record) => record.join("") === challenge.value))
        throw new Error(
          `Enterprise SSO domain verification failed for ${domain}.`,
        );
    }),
  );
  return providers;
}

function validateProvider(
  provider: EnterpriseSsoProvider,
  origin: string,
): void {
  if (
    !IDENTIFIER.test(provider.id) ||
    !provider.id.startsWith("sso-") ||
    !provider.tenantId.trim() ||
    !DOMAIN.test(provider.domain) ||
    !["optional", "required"].includes(provider.mode)
  ) {
    throw new Error("Invalid enterprise SSO provider configuration.");
  }
  switch (provider.protocol) {
    case "oidc":
      validateOidcProvider(provider, origin);
      return;
    case "saml":
      validateSamlProvider(provider, origin);
      return;
    default:
      throw new Error("Unsupported enterprise SSO protocol.");
  }
}

function validateOidcProvider(
  provider: Extract<EnterpriseSsoProvider, { protocol: "oidc" }>,
  origin: string,
): void {
  const authMethod = provider.tokenEndpointAuthentication;
  if (
    !provider.clientId.trim() ||
    !provider.clientSecret ||
    (authMethod !== undefined &&
      !["client_secret_basic", "client_secret_post"].includes(authMethod))
  )
    throw new Error(
      "Enterprise OIDC requires valid confidential client credentials.",
    );
  for (const endpoint of [
    provider.issuer,
    provider.authorizationEndpoint,
    provider.tokenEndpoint,
    provider.jwksEndpoint,
  ])
    validateEndpoint(endpoint, origin);
}

function validateSamlProvider(
  provider: Extract<EnterpriseSsoProvider, { protocol: "saml" }>,
  origin: string,
): void {
  if (
    !origin.startsWith("https:") ||
    !provider.entityId.trim() ||
    provider.emailAttribute?.trim() === ""
  )
    throw new Error(
      "Enterprise SAML requires an HTTPS application origin and valid IdP settings.",
    );
  validateEndpoint(provider.signInUrl, origin);
  const certificate = new X509Certificate(provider.signingCertificate);
  const now = Date.now();
  if (
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) <= now
  )
    throw new Error(
      "Enterprise SAML IdP signing certificate is outside its validity period.",
    );
}

function validateEndpoint(endpoint: string, origin: string): void {
  const url = new URL(endpoint);
  const sameDevelopmentOrigin =
    url.origin === origin && origin.startsWith("http:");
  if (
    (!sameDevelopmentOrigin &&
      (url.protocol !== "https:" ||
        isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "Enterprise SSO requires HTTPS IdP endpoints without embedded credentials or fragments.",
    );
  }
}

export function enterpriseEmailDomain(email: unknown): string | undefined {
  return normalizeIdentityEmail(email)?.split("@").at(-1);
}

export function enterpriseProviderBinding(
  provider: EnterpriseSsoProvider,
): string {
  const authority =
    provider.protocol === "oidc"
      ? [provider.issuer, provider.clientId]
      : [provider.entityId, provider.signingCertificate];
  return createHash("sha256")
    .update(
      JSON.stringify([
        provider.id,
        provider.tenantId,
        provider.domain,
        provider.protocol,
        ...authority,
      ]),
    )
    .digest("base64url");
}
