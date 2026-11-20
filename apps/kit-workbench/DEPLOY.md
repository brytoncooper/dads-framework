# Run the starter outside development

For local development, use `npm start` to run the Compose stack and see its
assigned URLs. The [starter README](./README.md#start) covers that workflow.

Use the generated project as the deployment unit for a host or container.
The API needs Node 24, a reachable PostgreSQL database, and a supervisor
that can start Node and send it a termination signal.

## Prepare the release

1. Install from the committed lockfile with `npm ci` and run
   `npm run verify`. Provide Docker for the tests that start disposable
   PostgreSQL.
2. Run `npm run build:web`. Serve the entire `dist/` directory, including
   its assets and license files. Configure a fallback to `index.html` for
   browser routes and forward the browser's same-origin `/api` requests to
   the customer API.
3. Configure `DATABASE_URL` and `DADS_IDENTITY_SECRET` in the runtime's
   secret store. Set `DADS_BASE_URL` to the public HTTPS origin for sign-in.
   Keep the origin and secret consistent across replicas of the same API.
4. Connect application email delivery to a real provider and configure
   durable storage for features that write files.
5. Run `npm run migrate` once against the intended database before starting
   the new API processes. Review migration output before opening traffic.

## Start and check

Set `NODE_ENV=production` and run `npm run start:api`. Select
`DADS_API=customer` for the customer routes or `DADS_API=staff` for the staff
routes. Set `PORT` for each process and `HOST` to the interface reached by
your ingress. Terminate HTTPS at the ingress and forward the original
origin and cookie headers so sign-in stays on the intended origin.

For example, start a customer process behind a same-host HTTPS proxy after setting the database, identity, and email configuration above:

```sh
NODE_ENV=production DADS_API=customer HOST=127.0.0.1 PORT=3000 npm run start:api
```

From a second terminal on that host, check liveness:

```sh
curl -fsS http://127.0.0.1:3000/api/health
```

A running API returns HTTP 200:

```json
{ "data": { "status": "ok" } }
```

Open the deployed workbench and create an account. Verify the account through
delivered email, sign in, create a workspace, and add a note. In the browser's
Network tab, confirm the note read returns HTTP 200. In a separate profile,
sign in with an account outside that workspace. Open the same notes API URL
and expect HTTP 404. Confirm the staff origin exposes only the intended routes.
Verify HTTPS and email delivery in the environment you operate.

## Enable enterprise identity

Start with a migrated database and create the tenant through the customer
API. Record its ID. Supply the optional settings below through the runtime
secret store and restart the affected replicas.

### OIDC or SAML sign-in

Set `DADS_ENTERPRISE_SSO_PROVIDERS` to a JSON array. Each entry includes an
`id` beginning with `sso-`, the existing `tenantId`, a lowercase DNS
`domain`, `mode` of `optional` or `required`, and a `protocol`.

| Protocol | Additional provider fields                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oidc`   | `issuer`, `clientId`, `clientSecret`, `authorizationEndpoint`, `tokenEndpoint`, `jwksEndpoint`, optional `tokenEndpointAuthentication` of `client_secret_basic` or `client_secret_post` |
| `saml`   | `entityId`, `signInUrl`, `signingCertificate` in PEM format, optional `emailAttribute`                                                                                                  |

Validate domain control by publishing the TXT record returned by
`enterpriseSsoDomainChallenge(secret, tenantId, domain)` from
`@dads-framework/identity-better-auth`. Pass the identity secret already
loaded by the operator's process. Publish only the returned `name` and
`value`. Use the same provider policy on every customer and staff deployment
serving those tenants.

Register `/api/auth/sso/callback` at the public API origin as the OIDC redirect
URI. For SAML, import the service provider metadata from
`/api/auth/sso/saml2/sp/metadata?providerId=<id>` and register
`/api/auth/sso/saml2/sp/acs/<id>` as the assertion consumer service URL.
Use the public addresses for each participating API origin.

A sign-in client starts the flow with a same-origin
`POST /api/auth/sign-in/sso` containing `providerId` and a same-origin
`callbackURL`, then navigates to the URL returned in the response. In
`required` mode, members need an SSO session for that tenant's scoped
routes. Tenant permissions still come from membership. Verify the flow
with a provisioned account and an account without tenant membership
before switching from `optional` to `required`.

### SCIM user provisioning

Create a random bearer token with at least 32 bytes of entropy. Store the
token at the IdP and place its lowercase SHA-256 hex digest in
`DADS_ENTERPRISE_SCIM` as a JSON array of entries with `tenantId` and `tokenSha256`. Give each token its own digest.
Set that variable only on customer replicas. Point the IdP at
`https://<customer-origin>/scim/v2` and forward the `Authorization` header
through the ingress. Confirm an unauthenticated request to
`/scim/v2/ServiceProviderConfig` gets 401 and the IdP's bearer token gets 200.
Each bearer credential manages the Users and Groups in its configured tenant.

On a SCIM-enabled tenant, the owner can link a verified account with an
existing membership using
`POST /api/tenants/<tenant-id>/scim/users/<scim-user-id>/bind`. Send the
owner's session cookie, the configured browser origin, and a JSON body
with the member's `accountId`. The endpoint calls `tenants.bindScimUser`
and returns `204`. The tenant adapter revokes the linked membership when
SCIM deactivates or deletes its user. Keep the tenant owner on the
operator's normal account lifecycle.
To rotate access, add a new digest for the same tenant on every customer
replica, update the token at the IdP, then remove the old digest. Remove `DADS_ENTERPRISE_SCIM` and restart customer
replicas to unmount provisioning.

### Staff support impersonation

Set `DADS_ENTERPRISE_STAFF_IMPERSONATION` on the staff API to one JSON object
with `tenantId`, `staffAccountIds`, and `revokerAccountIds`. Use an existing
tenant UUID and the account IDs of approved operators. Set
`revokerAccountIds` to an empty array to grant no separate revocation access.
Apply the same policy on all staff replicas.

A signed-in operator sends JSON to `POST /api/staff/impersonation` with the
staff origin in the `Origin` header and the staff session cookie. The request
body selects one of these actions.

| Action        | Additional field     | Result                                                                             |
| ------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `start`       | `effectiveAccountId` | Issues a grant for an account with access to the configured tenant.                |
| `view-tenant` | `grantId`            | Reads the tenant's ID and name as the target through its existing view permission. |
| `stop`        | `grantId`            | Ends a grant from its original issuing session.                                    |
| `revoke`      | `grantId`            | Ends a grant when the requester is listed in `revokerAccountIds`.                  |

Grants expire after five minutes or when the issuing session expires,
whichever comes first. Starting and using a grant recheck the allowlist and
the target's tenant access. When SSO is required for the configured tenant,
the staff session needs that tenant's SSO provenance. A grant is usable only
with the original staff session and only for `view-tenant`.

Review attempts in the PostgreSQL `identity_staff_impersonation_audit` table.
Events carry the initiating actor, the issuing staff account, the effective
account, and the tenant where available. Remove the configuration and restart
staff replicas to unmount the endpoint. Verify the customer API, a different
session for the same staff account, and a revoked grant all receive HTTP 404.
