import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn: readonly string[] = [];

export function up(migration: MigrationBuilder): void {
  migration.sql(`
    CREATE TABLE identity_users (
      id text PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL DEFAULT false,
      image text,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL
    );

    CREATE TABLE identity_credentials (
      id text PRIMARY KEY,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES identity_users (id) ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      scope text,
      password text,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL,
      UNIQUE ("providerId", "accountId")
    );
    CREATE INDEX identity_credentials_user_id_idx ON identity_credentials ("userId");

    CREATE TABLE identity_sessions (
      id text PRIMARY KEY,
      token text NOT NULL UNIQUE,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES identity_users (id) ON DELETE CASCADE
    );
    CREATE INDEX identity_sessions_user_id_idx ON identity_sessions ("userId");

    CREATE TABLE identity_verifications (
      id text PRIMARY KEY,
      identifier text NOT NULL,
      value text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL
    );
    CREATE INDEX identity_verifications_identifier_idx ON identity_verifications (identifier);

    CREATE TABLE identity_signing_keys (
      id text PRIMARY KEY,
      "publicKey" text NOT NULL,
      "privateKey" text NOT NULL,
      "createdAt" timestamptz NOT NULL,
      "expiresAt" timestamptz
    );

    CREATE TABLE identity_account_invitations (
      digest text PRIMARY KEY,
      email text NOT NULL,
      expires_at timestamptz NOT NULL,
      issued_by text NOT NULL REFERENCES identity_users (id) ON DELETE CASCADE
    );
    CREATE INDEX identity_account_invitations_expires_at_idx ON identity_account_invitations (expires_at);
  `);
}

export function down(migration: MigrationBuilder): void {
  migration.sql(`
    DROP TABLE identity_account_invitations;
    DROP TABLE identity_signing_keys;
    DROP TABLE identity_verifications;
    DROP TABLE identity_sessions;
    DROP TABLE identity_credentials;
    DROP TABLE identity_users;
  `);
}
