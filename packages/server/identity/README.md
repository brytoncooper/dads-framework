# @dads-framework/identity

The account, session, and mail contracts used by Dads applications and their identity adapters.

## Try it

In the generated starter, [`assembly/session-subjects.ts`](../../../apps/kit-workbench/assembly/session-subjects.ts) reads the
`Identity` session and maps the authenticated account to an authorization
subject at the HTTP boundary.

Use Node.js 22 or later. The test adapter uses an explicitly seeded cookie
and a fixed clock. It needs no identity provider or database.

```sh
npm install @dads-framework/identity
npm install -D tsx
```

Save as `read-session.mts` and run `npx tsx read-session.mts`.

<!-- dads:check-example -->

```ts
import type { Identity } from "@dads-framework/identity";
import {
  inMemoryIdentity,
  inMemoryIdentityCookie,
} from "@dads-framework/identity/testing";

async function currentAccount(identity: Identity, headers: Headers) {
  const session = await identity.readSession(headers);
  return session?.account ?? null;
}

const identity = inMemoryIdentity(
  {
    fixture: {
      account: {
        id: "alice",
        email: "alice@example.test",
        emailVerified: true,
      },
      expiresAt: new Date("2030-01-02T00:00:00Z"),
    },
  },
  () => new Date("2030-01-01T00:00:00Z"),
);
const headers = new Headers({ cookie: inMemoryIdentityCookie("fixture") });
console.log((await currentAccount(identity, headers))?.id);
console.log(await currentAccount(identity, new Headers()));
```

The script prints `alice` for the seeded session and `null` without a cookie.

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

## SCIM user provisioning

Import `createScimHandler` from `@dads-framework/identity/scim` and mount
its Fetch handler at the configured SCIM URL. This example assumes the
application supplies a `ScimDirectory` and a bearer credential lookup.

```ts
import {
  createScimHandler,
  type ScimDirectory,
} from "@dads-framework/identity/scim";

export function provisioning(
  directory: ScimDirectory,
  tenantForCredential: (token: string) => Promise<string | null>,
) {
  return createScimHandler({
    baseUrl: "https://example.com/scim/v2",
    authenticate: tenantForCredential,
    directory,
  });
}
```

The credential lookup returns the credential's tenant identifier or `null`.
Every directory call uses that tenant. The application owns credential issuance,
revocation, and storage, and serves the handler over HTTPS. The directory
allocates stable IDs, scopes every read and write, enforces case-insensitive
`userName` uniqueness within a tenant, and runs each update callback atomically.
A throwing update must roll back. IDs must fit in a single URL path segment.
A successful delete makes the user undiscoverable and retires its ID.

The handler implements SCIM User create, get, list, replace, patch, and delete.
Request bodies are limited to 64 KiB.
Set `active` to `false` to deactivate. List supports one-based `startIndex`,
`count` up to 100, and a single `eq` filter on `id`, `userName`, `externalId`,
`displayName`, `active`, or `emails.value`. PATCH supports add, replace, and
remove on supported writable fields, including individual `name` fields and
the whole `emails` collection. The schema endpoint lists supported User fields.
Service provider discovery advertises unsupported bulk, sort, password change,
and ETag capabilities. User schema extensions and filtered User PATCH paths
are outside this profile.

Supply a `ScimGroupDirectory` as the optional `groups` handler option to
expose Groups in discovery. The Group profile supports create, get, list,
replace, patch, and delete. List accepts an `eq` filter on `displayName`,
`externalId`, or `id`. PATCH supports adding and replacing the whole
`members` collection and removing members through `members[value eq "user-id"]`
or an explicit list of member values. Groups accept up to 1,000 members per
resource. Each member must refer to a SCIM User in the credential tenant.
The directory validates those references in the same transaction as the write.
SCIM group membership is directory data. Application roles are managed separately.

See [SCIM Core Schema](https://www.rfc-editor.org/rfc/rfc7643) and
[SCIM Protocol](https://www.rfc-editor.org/rfc/rfc7644).

## Staff impersonation

Use a short-lived grant to let a staff member act as a specific account in one tenant. The caller keeps their own session, so the audit trail can record who acted and on whose behalf. [Configure staff impersonation](./src/impersonation/README.md)
