import {
  sso,
  type SSOOptions,
  type SSOUserResolutionInput,
  type SSOUserResolution,
} from "@better-auth/sso";
import { APIError } from "better-auth/api";
import type { BetterAuthOptions } from "better-auth";
import { normalizeIdentityEmail } from "@dads-framework/identity";
import {
  enterpriseProviderBinding,
  enterpriseEmailDomain,
  type EnterpriseSsoProvider,
} from "./enterprise-options.js";
import { enterpriseCallback } from "./enterprise-callback-context.js";
import { IDENTITY_PATH } from "./identity-options.js";

export const OIDC_CALLBACK = "/sso/callback";
export const SAML_CALLBACK = "/sso/saml2/sp/acs";

export function enterpriseSsoPlugin(
  providers: readonly EnterpriseSsoProvider[],
  origin: string,
) {
  return sso({
    modelName: "identity_sso_providers",
    providersLimit: 0,
    redirectURI: OIDC_CALLBACK,
    domainVerification: { enabled: true },
    organizationProvisioning: { disabled: true },
    trustEmailVerified: true,
    saml: {
      allowIdpInitiated: false,
      enableInResponseToValidation: true,
      requireTimestamps: true,
    },
    defaultSSO: providers.map((provider) => vendorProvider(provider, origin)),
    resolveUser: resolveEnterpriseUser,
    guardProviderMutation: () => {
      throw denied();
    },
  });
}

export function enterpriseDatabaseHooks(
  providers: readonly EnterpriseSsoProvider[],
): NonNullable<BetterAuthOptions["databaseHooks"]> {
  return {
    user: {
      create: {
        before: (user, ctx) => {
          const callback = enterpriseCallback();
          if (callback === undefined) {
            return Promise.resolve(
              ctx?.path === "/sign-up/email" &&
                forEmail(providers, user.email)?.mode === "required"
                ? false
                : undefined,
            );
          }
          if (
            enterpriseEmailDomain(user.email) !== callback.provider.domain ||
            (callback.provider.protocol === "oidc" && !user.emailVerified)
          )
            throw denied();
          return Promise.resolve(
            callback.provider.protocol === "saml"
              ? { data: { ...user, emailVerified: true } }
              : undefined,
          );
        },
      },
    },
    account: {
      create: {
        before: (account) => {
          const callback = enterpriseCallback();
          if (callback === undefined) return Promise.resolve();
          if (
            !callback.profileApproved ||
            account.providerId !== callback.provider.id
          )
            throw denied();
          return Promise.resolve({
            data: {
              ...account,
              ssoProviderBinding: enterpriseProviderBinding(callback.provider),
              accessToken: undefined,
              refreshToken: undefined,
              idToken: undefined,
            },
          });
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          const user = await ctx?.context.internalAdapter.findUserById(
            session.userId,
          );
          if (user === null || user === undefined) return false;
          const provider = forEmail(providers, user.email);
          const callback = enterpriseCallback();
          if (callback === undefined) {
            if (provider?.mode === "required") throw denied();
            return undefined;
          }
          if (callback.provider !== provider || !callback.profileApproved)
            throw denied();
          return {
            data: {
              ...session,
              ssoProviderBinding: enterpriseProviderBinding(callback.provider),
            },
          };
        },
      },
    },
  };
}

export function forEmail(
  providers: readonly EnterpriseSsoProvider[],
  email: unknown,
) {
  const domain = enterpriseEmailDomain(email);
  return providers.find((provider) => provider.domain === domain);
}

const rejectEnterpriseSso: SSOUserResolution = {
  action: "reject",
  code: "ENTERPRISE_SSO_SIGN_IN_DENIED",
};

const resolveEnterpriseUser: NonNullable<SSOOptions["resolveUser"]> = async (
  input,
  { database },
) => {
  const callback = enterpriseCallback();
  if (callback === undefined) return rejectEnterpriseSso;
  const provider = callback.provider;
  const email = verifiedProfileEmail(input, provider);
  if (email === null) return rejectEnterpriseSso;

  const linked = await database.findOne<{
    userId: string;
    ssoProviderBinding?: string;
  }>({
    model: "account",
    where: [
      { field: "providerId", value: provider.id },
      { field: "accountId", value: input.accountKey.accountId },
    ],
  });
  const user = await database.findOne<{
    id: string;
    email: string;
    emailVerified: boolean;
  }>({
    model: "user",
    where: [
      linked === null
        ? { field: "email", value: email }
        : { field: "id", value: linked.userId },
    ],
  });
  if (!isVerifiedLocalBinding(user, linked, provider, email))
    return rejectEnterpriseSso;
  callback.profileApproved = true;
  return user === null
    ? { action: "continue" }
    : { action: "link", userId: user.id, profile: "preserve" };
};

function isVerifiedLocalBinding(
  user: { email: string; emailVerified: boolean } | null,
  linked: { ssoProviderBinding?: string } | null,
  provider: EnterpriseSsoProvider,
  email: string,
): boolean {
  if (
    linked !== null &&
    (user === null ||
      linked.ssoProviderBinding !== enterpriseProviderBinding(provider))
  )
    return false;
  return user === null || (user.emailVerified && user.email === email);
}

function verifiedProfileEmail(
  input: SSOUserResolutionInput,
  provider: EnterpriseSsoProvider,
): string | null {
  const email = normalizeIdentityEmail(input.providerUser.email);
  if (
    input.providerReference.source.type !== "configured" ||
    input.providerId !== provider.id ||
    input.protocol !== provider.protocol ||
    email === null ||
    enterpriseEmailDomain(email) !== provider.domain ||
    input.accountKey.accountId.length === 0
  )
    return null;
  return claimMatches(input, provider, email) ? email : null;
}

function claimMatches(
  input: SSOUserResolutionInput,
  provider: EnterpriseSsoProvider,
  email: string,
): boolean {
  if (input.protocol === "oidc" && provider.protocol === "oidc") {
    return (
      input.accountKey.issuer === provider.issuer &&
      input.verifiedIdTokenClaims["email_verified"] === true
    );
  }
  if (input.protocol === "saml" && provider.protocol === "saml") {
    const claim = input.providerAttributes[provider.emailAttribute ?? "email"];
    return (
      input.accountKey.issuer === provider.entityId &&
      singleSamlEmail(claim) === email
    );
  }
  return false;
}

function singleSamlEmail(
  claim: string | readonly string[] | undefined,
): string | null {
  if (typeof claim === "string") return normalizeIdentityEmail(claim);
  return claim?.length === 1 ? normalizeIdentityEmail(claim[0]) : null;
}

function denied(): APIError {
  return new APIError("FORBIDDEN", { message: "Enterprise sign-in denied." });
}

function vendorProvider(provider: EnterpriseSsoProvider, origin: string) {
  const common = { domain: provider.domain, providerId: provider.id };
  if (provider.protocol === "oidc")
    return {
      ...common,
      oidcConfig: {
        issuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        authorizationEndpoint: provider.authorizationEndpoint,
        tokenEndpoint: provider.tokenEndpoint,
        jwksEndpoint: provider.jwksEndpoint,
        tokenEndpointAuthentication: provider.tokenEndpointAuthentication,
        discoveryEndpoint: "",
        pkce: true,
        scopes: ["openid", "email", "profile"],
      },
    };
  const callbackUrl = `${origin}${IDENTITY_PATH}${SAML_CALLBACK}/${provider.id}`;
  const issuer = `${origin}${IDENTITY_PATH}/sso/saml2/sp/metadata?providerId=${provider.id}`;
  return {
    ...common,
    samlConfig: {
      issuer,
      entryPoint: provider.signInUrl,
      cert: provider.signingCertificate,
      callbackUrl,
      idpMetadata: {
        entityID: provider.entityId,
        cert: provider.signingCertificate,
      },
      spMetadata: { entityID: issuer },
      wantAssertionsSigned: true,
      identifierFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      mapping: { email: provider.emailAttribute },
    },
  };
}
