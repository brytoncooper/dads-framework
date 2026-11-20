import type { IdentityEmail } from "@dads-framework/identity";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { PostgresDialect } from "kysely";
import {
  IDENTITY_PATH,
  type BetterAuthIdentityOptions,
} from "./identity-options.js";

const SESSION_SECONDS = 60 * 60 * 24 * 7;

export function configureBetterAuth(
  options: BetterAuthIdentityOptions,
  origin: string,
  sendEmail: (email: IdentityEmail) => void,
) {
  return betterAuth({
    baseURL: origin,
    basePath: IDENTITY_PATH,
    secret: options.secret,
    database: {
      dialect: new PostgresDialect({ pool: options.database.pool }),
      type: "postgres",
      transaction: true,
    },
    user: { modelName: "identity_users" },
    account: { modelName: "identity_credentials" },
    verification: {
      modelName: "identity_verifications",
      storeIdentifier: "hashed",
    },
    session: {
      modelName: "identity_sessions",
      expiresIn: SESSION_SECONDS,
      updateAge: 0,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 900,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => {
        sendEmail({ kind: "reset-password", to: user.email, url });
        return Promise.resolve();
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 3600,
      sendVerificationEmail: ({ user, url }) => {
        sendEmail({ kind: "verify-email", to: user.email, url });
        return Promise.resolve();
      },
    },
    rateLimit: { enabled: true },
    telemetry: { enabled: false },
    logger: { disabled: true },
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwt: {
          issuer: origin,
          audience: origin,
          expirationTime: "5m",
          definePayload: ({ session }) => ({ sid: session.id }),
        },
        schema: { jwks: { modelName: "identity_signing_keys" } },
      }),
    ],
  });
}
