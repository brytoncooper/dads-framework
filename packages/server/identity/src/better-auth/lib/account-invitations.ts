import { randomBytes } from "node:crypto";
import type { IdentityEmail, IdentitySession } from "../../index.js";
import { digestToken } from "../../lib/digest-token.js";
import type { PostgresPool } from "kysely";
import type { BetterAuthIdentityOptions } from "./identity-options.js";

const INVITATION_SECONDS = 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export function createAccountInvitations(
  options: BetterAuthIdentityOptions,
  origin: string,
  sendEmail: (email: IdentityEmail) => void,
) {
  const { pool } = options.database;
  return {
    async issue(session: IdentitySession, email: string): Promise<boolean> {
      if (
        !session.account.emailVerified ||
        !(await options.canInvite(session.account))
      ) {
        return false;
      }
      const token = randomBytes(32).toString("base64url");
      await runInvitationQuery(
        pool,
        `INSERT INTO identity_account_invitations
          (digest, email, expires_at, issued_by)
         VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3), $4)`,
        [digestToken(token), email, INVITATION_SECONDS, session.account.id],
      );
      const url = new URL("/accept-invitation", origin);
      url.hash = new URLSearchParams({ token }).toString();
      sendEmail({ kind: "account-invitation", to: email, url: url.href });
      return true;
    },
    async accept(session: IdentitySession, token: unknown): Promise<boolean> {
      if (
        !session.account.emailVerified ||
        typeof token !== "string" ||
        !TOKEN.test(token)
      ) {
        return false;
      }
      const deleted = await runInvitationQuery(
        pool,
        `DELETE FROM identity_account_invitations
          WHERE digest = $1 AND email = $2 AND expires_at > clock_timestamp()`,
        [digestToken(token), session.account.email.trim().toLowerCase()],
      );
      return deleted === 1;
    },
  };
}

async function runInvitationQuery(
  pool: PostgresPool,
  statement: string,
  parameters: readonly unknown[],
): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query(statement, parameters);
    return result.rowCount;
  } finally {
    client.release();
  }
}
