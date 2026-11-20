# @dads-framework/identity

The account, session, and mail contracts used by Dads applications and their identity adapters.

## Try it

```ts
import type { Identity } from "@dads-framework/identity";

export async function currentAccount(identity: Identity, request: Request) {
  const session = await identity.readSession(request.headers);
  return session?.account ?? null;
}
```

## Use it

The application mounts `Identity.handle` at the adapter's HTTP boundary and
calls `Identity.readSession` in server-side authentication. Map a successful
lookup to the application's account or authorization subject. An email
address or user ID from a request body is never proof of identity.

`normalizeIdentityEmail` accepts an untrusted value and returns a normalized
email address for invitations or `null` when it cannot use the value.

## What it refuses to do

This package has no database, password implementation, network calls, or role
policy. The identity adapter verifies the session and the application decides
what its account can access.

## Contract

`IdentitySession.account` contains an ID, email, and email verification flag.
`expiresAt` is the server-side session expiration. A missing, expired, or revoked
session resolves to `null`. Operational failures can reject the lookup and
must fail closed in the application.

`EnqueueIdentityEmail` receives an address and a confidential link.
Applications own message delivery and keep addresses and links out of logs.

## Testing sessions

`@dads-framework/identity/testing` provides `inMemoryIdentity` for tests that
seed verified sessions and control their clock.
`verifyIdentitySessionConformance` runs the same read, expiry, and revocation
laws against that stand-in and the database adapter.
