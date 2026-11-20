# @dads-framework/identity-better-auth

Binds the Dads identity contract to Better Auth and PostgreSQL for email and password sign-in.

## Try it

```ts
import { createBetterAuthIdentity } from "@dads-framework/identity-better-auth";

const identity = createBetterAuthIdentity({
  database: postgres,
  baseUrl: environment.appOrigin,
  secret: environment.identitySecret,
  enqueueEmail: mailQueue.enqueueIdentityEmail,
  canInvite: accountPolicy.canInvite,
});
```

## Use it

Apply the migration with the Dads migration runner. It discovers
`20261120070500_identity.migration.ts` for this repository. An adopter can
call `installIdentitySchemaV1` from its own migration via the package's
public export. Mount `identity.handle` under `IDENTITY_PATH` (`/api/auth`)
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

The handler omits SSO, SCIM, administrative impersonation and provider
token endpoints. Reads return account identity without password or raw
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
