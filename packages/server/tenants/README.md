# `@dads-framework/tenants`

Manage tenants, memberships, and one-time invitations with relationship authorization.

## Try it

In the generated starter, [`libraries/app-runtime/index.ts`](../../../apps/kit-workbench/libraries/app-runtime/index.ts) declares tenant
access against the application's account entity. [`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts)
constructs `Tenants` and supplies transaction-bound authorization so membership
rows and relationship facts commit together.

Use Node.js 22 or later and a disposable Postgres database. Install the tuple
table and complete tenant schema in one migration before running the script below.

```sh
npm install @dads-framework/access @dads-framework/postgres @dads-framework/postgres-access @dads-framework/tenants zod
npm install -D tsx
```

In your migration runner, pass its builder to
`pgm.sql(relationshipSchemaMigration.sql)` and `installTenantSchemaV2(pgm)`.
The first export comes from `@dads-framework/postgres-access` and the second
from `@dads-framework/tenants`. Set `DATABASE_URL` to connect to the migrated
database. This script uses fixture account IDs. In an application, resolve
those IDs from verified sessions before invoking the tenant service.

Save as `create-tenant.mts` and run `npx tsx create-tenant.mts`.

<!-- dads:check-example -->

```ts
import { access, accessModel, entityHandle } from "@dads-framework/access";
import { createPostgresConnection } from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import {
  createTenantAccess,
  TenantUnavailableError,
  Tenants,
} from "@dads-framework/tenants";
import { z } from "zod";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL.");

const account = entityHandle({ wireName: "account", idSchema: z.string() });
const tenantAccess = createTenantAccess(account);
const model = accessModel([
  access(account, { roles: {}, permissions: () => ({}) }),
  tenantAccess.tenant,
]);

const connection = createPostgresConnection(
  { connectionString, schema: {} },
  console,
);
try {
  const backend = new PostgresAuthorization({
    model,
    namespace: "tenant-example",
    executor: connection.pool,
  });
  const tenants = new Tenants({
    database: connection.drizzle,
    access: tenantAccess,
    authorizationAt: (tx) => backend.inDrizzleTransaction(tx),
    changes: new TransactionalAccessChanges(backend, connection.drizzle),
  });

  const tenant = await tenants.create("alice", "Example workspace");
  const context = await tenants.context("alice", tenant.id);
  console.log(context.tenant.name);
  try {
    await tenants.context("outside-account", tenant.id);
    throw new Error("Expected access to be denied.");
  } catch (error) {
    if (!(error instanceof TenantUnavailableError)) throw error;
    console.log(error.constructor.name);
  }
} finally {
  await connection.close();
}
```

The script prints `Example workspace` and `TenantUnavailableError`. The
creator's owner relationship commits in the same transaction as the tenant
and its membership row.

## Use it

Use the account ID from the application's authenticated session. Pass request tenant IDs through `tenantIdSchema`. `list(accountId)` asks authorization for visible tenant IDs and loads only those rows. `context(accountId, tenantId)` checks the tenant before returning its metadata, feature flag audience, and audit scope. `rename` requires the owner relationship.

`memberships.roster` is available to owners and admins. Owners can promote members and remove admins. Admins can invite and remove ordinary members. The bootstrap owner relationship stays in place.

`memberships.permissions(actorId, tenantId, accountId)` returns the selected member's role and checks their effective `view`, `manageMembers`, and `manageTenant` permissions. It requires membership management permission on that tenant. Missing members produce `TenantUnavailableError`.

`invitations.issue(accountId, tenantId, recipientEmail)` produces a one-time token and its expiration. Deliver that token to the recipient through the application's invitation link or email. `invitations.accept(token, session.account)` accepts only the intended account with a verified email. The account session supplies `id`, `email`, and `emailVerified`. The token digest, expiry, and redemption state stay in storage. Tenant invitations grant membership and work with identity systems that support verified account emails.

Applications with tenant sign-in requirements can pass a
`TenantInvitationAcceptanceCheck` as the third argument to
`invitations.accept`. The callback receives the locked invitation's tenant,
the verified accepting account, and the same Postgres transaction. Return
`true` to permit redemption. Denial leaves the invitation unconsumed and
membership unchanged. Use the supplied tenant and account for policy lookup.

Use `context.audience` for feature flag evaluation and `context.auditScope` for tenant audit reads. `tenantAuditConfiguration` defines the `tenant_id` dimension for tenant and membership records. It excludes invitation rows. Bind `createTenantDirectory(database)` as the flag manager's platform-authorized tenant directory.

## What it refuses to do

Membership administration rejects access across tenant boundaries. The service denies missing tenants and tenants the caller cannot access through the same error. Invitation redemption rejects missing, expired, consumed, or mismatched invitations through the same error. The issuer's membership management permission must still be active.

## Contract

The data and authorization ports use the same serializable Postgres transaction. On an empty database, install the package's `tenantMigrations` through the
application's runner or call `installTenantSchemaV2` in an application-owned
migration. Both options install tenant, membership, invitation, and SCIM
user and group storage. Choose one path. Invitation acceptance always checks
directory user storage for a deactivated account binding. The Postgres access adapter has [Trusted experimental status](../postgres-access/README.md#trusted-experimental). Applications can own additional kinds and sub-scopes in their composed access model.

Translate `TenantUnavailableError` and `TenantInvitationUnavailableError` at the transport boundary. A database error rejects the transaction and leaves membership state unchanged. When a transaction retries after a PostgreSQL serialization failure, run the whole operation again.

## Upgrade an existing tenant schema

Keep applied migration files intact. If your application used only
`installTenantSchemaV1`, add a new forward migration that calls
`installTenantScimSchemaV1` followed by `installTenantScimGroupSchemaV1`.
Apply it before serving invitation acceptance. If the SCIM user installer
already ran, add only the group installer. Databases with both SCIM
migrations already applied, including the generated starter, have the
complete schema and need no additional tenant migration. Reserve
`installTenantSchemaV2` for fresh databases.

## SCIM provisioning

Use the same tenant options and synchronous Postgres access adapter for the
tenant service and the SCIM directory.

```ts
import { createScimHandler } from "@dads-framework/identity/scim";
import {
  createTenantScimDirectory,
  createTenantScimGroupDirectory,
} from "@dads-framework/tenants";

const scim = createScimHandler({
  baseUrl: "https://app.example.com/scim/v2",
  authenticate: resolveTenantFromScimBearer,
  directory: createTenantScimDirectory(tenantOptions),
  groups: createTenantScimGroupDirectory(tenantOptions),
});

// A tenant owner supplies an app-verified mapping to an existing local member.
await tenants.bindScimUser(
  ownerSession.account.id,
  tenant.id,
  scimUser.id,
  memberAccountId,
);
```

Mount the handler at its canonical base URL. Resolve each credential to the
tenant it manages and reject unknown or revoked credentials. SCIM profile
fields, including email and external ID, are directory data. Account linking
requires an explicit owner action and an existing non-owner membership in
that tenant. A local account can link to one SCIM user per tenant.

SCIM creation and reactivation leave membership grants to the application.
Setting `active` to `false` or deleting a linked SCIM user removes its
membership and relationship in the same transaction. Invitation redemption
requires an active linked user. Deletion removes the directory profile and
retains its resource ID and account binding. To onboard that same local
account again, provision a new active SCIM user, have an owner move the
verified account binding with `bindScimUser`, and grant membership through an
invitation. The deleted resource ID stays retired. Back up the table with
the tenant data. The default tenant audit configuration excludes SCIM
profile data.

SCIM Groups contain references to current SCIM users in the same tenant.
Deleting a user removes its group memberships in the same transaction.
Applications authorize tenant resources through their own role model. Group
membership carries no application authorization or staff role.

Authorize each tenant request on the primary database, including requests
made with existing account sessions. Use `Tenants.context` or the same
transactional authorization model for tenant resources. Application-owned
grants outside the tenant role model require their own revocation policy.
