# @dads-framework/identity-better-auth

Binds the Dads identity contract to Better Auth and PostgreSQL for email, password, and optional tenant SSO sign-in.

## Try it

Use Node.js 24 and a disposable Postgres database. Apply
`installIdentitySchemaV2(pgm)` from this package in your migration runner.
Set `DATABASE_URL` to point at the migrated database. Set `IDENTITY_SECRET`
to a locally generated secret of at least 32 characters. The example invokes
the HTTP handler directly, so it needs no listening HTTP server. It captures
the verification link in memory and keeps it out of the console.

```sh
npm install @dads-framework/identity-better-auth @dads-framework/postgres
npm install -D tsx
```

Save as `identity-boundary.mts` and run `npx tsx identity-boundary.mts`.

<!-- dads:check-example -->

```ts
import { randomUUID } from "node:crypto";
import {
  createBetterAuthIdentity,
  IDENTITY_PATH,
} from "@dads-framework/identity-better-auth";
import { createPostgresConnection } from "@dads-framework/postgres";

const connectionString = process.env.DATABASE_URL;
const secret = process.env.IDENTITY_SECRET;
if (!connectionString || !secret) {
  throw new Error("Set DATABASE_URL and IDENTITY_SECRET.");
}

const connection = createPostgresConnection(
  { connectionString, schema: {} },
  console,
);
const baseUrl = "http://localhost:3000";
try {
  let verificationUrl: string | undefined;
  const identity = createBetterAuthIdentity({
    database: connection,
    baseUrl,
    secret,
    enqueueEmail: async ({ kind, url }) => {
      if (kind === "verify-email") verificationUrl = url;
    },
    canInvite: async () => false,
  });

  function post(path: string, body: object) {
    return identity.handle(
      new Request(baseUrl + IDENTITY_PATH + path, {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  const email = `example-${randomUUID()}@example.test`;
  const password = randomUUID();
  const registration = await post("/sign-up/email", {
    name: "Example account",
    email,
    password,
  });
  if (registration.status !== 200 || verificationUrl === undefined) {
    throw new Error("Expected a verification email.");
  }

  console.log((await post("/sign-in/email", { email, password })).status);
  const verification = await identity.handle(new Request(verificationUrl));
  if (verification.status !== 302) throw new Error("Verification failed.");

  const signIn = await post("/sign-in/email", { email, password });
  console.log(signIn.status);
  const cookie = signIn.headers
    .getSetCookie()
    .find((value) => value.includes("session_token"))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");

  const session = await identity.readSession(new Headers({ cookie }));
  console.log(session?.account.emailVerified);
} finally {
  await connection.close();
}
```

The script prints `403` before email verification, `200` after verification,
and `true` when the session lookup confirms the verified account.

## Use it

For a fresh database, call `installIdentitySchemaV2(pgm)` from an
application-owned migration. It installs accounts, credentials, sessions,
verification and invitation records, and the signing-key schema required by
the default adapter.

```ts
import { installIdentitySchemaV2 } from "@dads-framework/identity-better-auth";

export const up = installIdentitySchemaV2;
export const down = false;
```

If you already applied a migration that only called `installIdentitySchemaV1`,
keep that migration and call `installIdentitySigningKeyMetadataSchema(pgm)`
once in a new migration. If your journal already applied the signing-key
migration, the default schema is complete. Dads repository deployments use
the shipped `20261120070500_identity.migration.ts` and
`20261120070530_identity_jwks.migration.ts` steps.

Mount `identity.handle` under `IDENTITY_PATH` (`/api/auth`)
and pass through the original browser request and response headers,
including each `Set-Cookie` header. Replace client-supplied forwarding
headers at the trusted ingress before invoking the handler. Better Auth
uses the resulting client address for request limits. An application
with multiple instances can also enforce shared limits at its ingress.

Use `identity.readSession(request.headers)` to authenticate with the session
cookie. Cookies are host-only, HTTP-only, and secure on HTTPS. The database
is checked on each lookup. Sessions expire seven days after sign-in and
sign-out revokes the current session.

From the same origin, use the following paths relative to `/api/auth`.

| Method | Path                      | Input and effect                                                                       |
| ------ | ------------------------- | -------------------------------------------------------------------------------------- |
| POST   | `/sign-up/email`          | `name`, `email`, `password`. Requests email verification with a uniform success body.  |
| GET    | `/verify-email`           | The verification URL delivered to the account owner.                                   |
| POST   | `/sign-in/email`          | `email`, `password`. Sets a session cookie for a verified account.                     |
| POST   | `/sign-out`               | Revokes the cookie's session.                                                          |
| GET    | `/get-session`            | Returns the safe account and its expiration, or `null`.                                |
| POST   | `/request-password-reset` | `email`, same-origin `redirectTo`. Returns a generic acknowledgement.                  |
| POST   | `/reset-password`         | `token`, `newPassword`. Consumes the token and revokes existing sessions.              |
| POST   | `/invite`                 | `email`. Requires a verified session and an application policy permitting invitations. |
| POST   | `/accept-invitation`      | `token` from the link's fragment. Requires a verified session with the same email.     |
| GET    | `/token`                  | A five-minute JWT for an active cookie session.                                        |
| GET    | `/jwks`                   | Public verification keys.                                                              |

An invited recipient signs up and verifies their address first. The
application's `/accept-invitation` page reads the token fragment and submits
it to the identity endpoint. An account invitation grants no tenant role.
Tenant onboarding can instead use its own tenant invitation and map a
verified identity session to a tenant account.

Password reset links expire after 15 minutes, verification links after an
hour, and account invitations after 24 hours. A password reset is
single-use. Invite tokens are stored by digest, accepted atomically, and
cannot be redeemed with another account's email.

## What it refuses to do

The handler omits SCIM, and provider token endpoints. Reads return account identity without password or raw
session records. JWTs carry only the subject, session ID, and standard
issuer, audience, time and expiry claims. An offline verifier must check
signature, issuer, audience and expiry. A revoked cookie session cannot
mint new JWTs, and existing offline JWTs expire within five minutes.

## Contract

Use a bare HTTPS origin or a loopback HTTP origin and a secret of at least
32 characters from application configuration. The application owns the
database pool and its shutdown. Use a confidential mail queue. Mail is
enqueued without delaying reset or registration responses, and enqueue
failures can call `onEmailError` without exposing any address, secret, or
link. Keep request bodies and authentication query strings out of logs.

Denied invitation issuance returns `401` without a session and `403` for a
refused origin or account policy. A wrong, expired, or spent invitation
returns the same `400` response.

## Staff impersonation storage

Use the PostgreSQL adapter with the vendor-neutral impersonation service.
Pass the primary PostgreSQL pool and an application policy that checks the
actor's permission for the specified action, tenant, and target.

```ts
import { createImpersonation } from "@dads-framework/identity/impersonation";
import { createPostgresImpersonationStore } from "@dads-framework/identity-better-auth/impersonation-store";

const impersonation = createImpersonation({
  ...createPostgresImpersonationStore(postgres.pool),
  identity,
  authorize: accountPolicy.authorizeImpersonation,
  lifetimeMs: 5 * 60_000,
});
```

Apply `20261120070700_staff_impersonation.migration.ts` for this repository.
In an adopting application, call `installStaffImpersonationSchemaV1` from a
migration through the same package subpath. The adapter adds a durable audit
row in the same PostgreSQL statement as each successful grant creation or
removal. A failure rolls back both writes. Every accepted use also requires a
durable audit row. Audit entries contain account IDs and grant IDs. The
server-side session ID is stored only with the grant.

Mount application-owned impersonation routes and explicitly allow the
operations that accept an impersonation grant. The underlying Better Auth
session remains the authenticated staff session. See the
[staff impersonation service guide](../identity/src/impersonation/README.md)
for the start, use, stop, and revoke contracts.

## Enterprise SSO

A trusted deployment administrator supplies one or more tenant providers via
`createEnterpriseBetterAuthIdentity(options, providers)`. Keep the provider
configuration and OIDC client secrets on the server. Use a different
`sso-` provider ID for each connection and a unique exact email domain.
Providers belonging to one tenant must have the same mode.

Call `enterpriseSsoDomainChallenge(options.secret, tenantId, domain)` and
publish its returned TXT name and value in the domain's DNS. The factory
checks the TXT record during startup. Leave the record published across
restarts and regenerate it when rotating the identity secret. The
provider catalog is deployment configuration. The HTTP handler exposes no
provider registration or mutation routes.

Apply `installIdentityEnterpriseSsoSchema(pgm)` in a separate migration
after installing the default identity schema.

### Connect and test a provider

1. Start with mode `optional`. For OIDC, configure a confidential client,
   registered issuer, authorization, token, and JWKS URLs. Use
   `/api/auth/sso/callback` on the application origin as the redirect URI.
   The provider must support PKCE and supply `email`, boolean
   `email_verified`, and an immutable subject in the signed ID token.
2. For SAML, configure the IdP entity ID, Redirect binding sign-in URL,
   signing certificate, and the email attribute when it differs from
   `email`. Register the SP using
   `GET /api/auth/sso/saml2/sp/metadata?providerId=<id>`.
   The metadata describes the application entity ID and ACS at
   `POST /api/auth/sso/saml2/sp/acs/<id>`. Configure signed responses with
   an immutable NameID, recipient, audience, and validity conditions.
3. From the application origin, send `POST /api/auth/sign-in/sso` with
   `{ providerId, callbackURL }` and navigate that browser to the returned
   `url`. Use a same-origin application callback. On return, verify
   `readEnterpriseSession(headers, tenantId)` and confirm the account and
   provider. Try a user outside the configured domain before enabling
   required mode.

A first SSO sign-in can provision a verified identity. If the email matches
an already verified local identity in the provider's domain, the transaction
binds the provider subject to that account. A later sign-in must match the
subject and verified email. The adapter does not store IdP tokens. Treat
the issuer, client ID or SAML certificate, tenant, domain, and provider ID
as the authority boundary. Rebinding an existing identity to changed
provider authority requires a controlled account migration with reviewed
credential changes. A deployment changing the authority invalidates
sessions minted under the previous binding.

For tenant routes, call `readTenantSession(headers, tenantId)` before
authorizing tenant membership. Required mode enforces that tenant's SSO
session, and password sessions for a required domain cannot authenticate
or mint identity JWTs. SSO does not assign tenant membership.

For reauthentication, initiate a new SSO round trip and call
`readEnterpriseSession(headers, tenantId, maxAgeMs)`. Compare its account
ID with the original actor for the sensitive action. Freshness measures
the completion of an application SSO flow. Configure IdP policy to
require a new credential prompt or MFA when that assurance is needed.

For a tenant invitation, read a verified session with
`readTenantSessionPolicy(headers)` before opening the membership transaction.
Apply its `allowsTenant(tenantId)` check to the tenant read from the locked
invitation. The check reuses the validated session without querying the pool
again while the transaction holds a connection.
