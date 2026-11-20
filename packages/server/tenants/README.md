# `@dads-framework/tenants`

Manage tenants, memberships, and one-time invitations with relationship authorization.

## Try it

```ts
import { accessModel } from "@dads-framework/access";
import {
  PostgresAuthorization,
  TransactionalAccessChanges,
  relationshipSchemaMigration,
} from "@dads-framework/postgres-access";
import {
  createTenantAccess,
  tenantMigrations,
  Tenants,
} from "@dads-framework/tenants";

// Install relationshipSchemaMigration.sql and tenantMigrations before serving traffic.
// Each account and tenant definition belongs to the same composed access model.
const access = createTenantAccess(accountDefinition.entity);
const model = accessModel([accountDefinition, access.tenant]);
const backend = new PostgresAuthorization({
  model,
  namespace: "app",
  executor: connection.pool,
});
const tenants = new Tenants({
  database: connection.drizzle,
  access,
  authorizationAt: (transaction) => backend.inDrizzleTransaction(transaction),
  changes: new TransactionalAccessChanges(backend, connection.drizzle),
});

const tenant = await tenants.create(session.account.id, "Example workspace");
const context = await tenants.context(session.account.id, tenant.id);
```

The creator gets the owner relationship. Tenant data and membership facts commit in one transaction on the primary database.

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

The data and authorization ports use the same serializable Postgres transaction. Install the package's migration folder through the application's migration runner, or call `installTenantSchemaV1` inside an application-owned migration. The Postgres access adapter has [Trusted experimental status](../postgres-access/README.md#trusted-experimental). Applications can own additional kinds and sub-scopes in their composed access model.

Translate `TenantUnavailableError` and `TenantInvitationUnavailableError` at the transport boundary. A database error rejects the transaction and leaves membership state unchanged. When a transaction retries after a PostgreSQL serialization failure, run the whole operation again.

## SCIM provisioning

Install `tenantMigrations` or call `installTenantScimSchemaV1` after
`installTenantSchemaV1`, followed by `installTenantScimGroupSchemaV1`. Use the same tenant options and synchronous Postgres
access adapter for the tenant service and the SCIM directory.

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
