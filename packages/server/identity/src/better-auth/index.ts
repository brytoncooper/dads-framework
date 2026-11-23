export { createBetterAuthIdentity } from "./lib/create-better-auth-identity.js";
export { IDENTITY_PATH, type BetterAuthIdentityOptions } from "./lib/identity-options.js";
export { installIdentitySchemaV2 } from "./lib/install-identity-schema-v2.js";
export { up as installIdentitySchemaV1 } from "./lib/migrations/20261120070500_identity.migration.js";

export { createEnterpriseBetterAuthIdentity } from "./lib/create-better-auth-identity.js";
export { enterpriseSsoDomainChallenge, type EnterpriseSsoProvider } from "./lib/enterprise-options.js";
export { up as installIdentityEnterpriseSsoSchema } from "./lib/migrations/20261120070600_enterprise_sso.migration.js";
export { up as installIdentitySigningKeyMetadataSchema } from "./lib/migrations/20261120070530_identity_jwks.migration.js";
export type { EnterpriseBetterAuthIdentity, EnterpriseSsoSession } from "./lib/identity-session-readers.js";
