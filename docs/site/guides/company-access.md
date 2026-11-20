# Connect a company directory

Use SSO to authenticate an account and SCIM to manage the directory records
for a workspace. The starter uses tenant memberships to decide which
workspace records the authenticated account can access.

The [0.3.0 starter](./quickstart.md#create-the-project) includes a local workspace where you can exercise the permissions, provisioning, and support flows below. [Run the starter examples](../../../apps/kit-workbench/examples/README.md)

## Turn on company sign-in

Create **Alpha** in a migrated starter and record its tenant ID. Put an
entry like this one in the `DADS_ENTERPRISE_SSO_PROVIDERS` array on every
customer and staff API that serves Alpha. Substitute your IdP's endpoints
and read the client secret from your runtime secret store.

```json
[
  {
    "id": "sso-alpha",
    "tenantId": "00000000-0000-4000-8000-000000000001",
    "domain": "alpha.example.test",
    "mode": "optional",
    "protocol": "oidc",
    "issuer": "https://login.alpha.example.test",
    "clientId": "dads-workbench",
    "clientSecret": "<oidc-client-secret>",
    "authorizationEndpoint": "https://login.alpha.example.test/authorize",
    "tokenEndpoint": "https://login.alpha.example.test/token",
    "jwksEndpoint": "https://login.alpha.example.test/keys"
  }
]
```

1. Publish the TXT name and value returned by
   `enterpriseSsoDomainChallenge(secret, tenantId, domain)`. Pass the
   app's identity signing secret to the helper in a trusted process.
2. Register `/api/auth/sso/callback` at your public API origin with the IdP.
   Restart the APIs. In the workbench, open **Sign in with company SSO**
   and enter `sso-alpha`. On completion the browser returns to the workbench.
3. Open Alpha's notes as a workspace member. Expect `200`. In a separate
   profile, try as an authenticated account without Alpha membership.
   Expect `404`.
4. Change `mode` to `required` and restart. The same Alpha member's
   password session gets `401` on `GET /api/tenants/<alpha-id>/notes`.
   Sign in through Alpha's provider and repeat the member check.

## Provision and offboard one user

Generate a separate bearer token for Alpha and calculate its digest.

```sh
scim_token=$(openssl rand -hex 32)
printf '%s' "$scim_token" | openssl dgst -sha256
```

Store the token with the directory. Set `DADS_ENTERPRISE_SCIM` on the
customer API, substituting Alpha's ID and the lowercase hex digest.

```json
[
  {
    "tenantId": "00000000-0000-4000-8000-000000000001",
    "tokenSha256": "<sha256-hex-digest>"
  }
]
```

Restart the customer API and send requests directly to its origin.

```http
POST /scim/v2/Users
Authorization: Bearer <alpha-scim-token>
Content-Type: application/scim+json

{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"riley@alpha.example.test"}
```

Expect `201 Created`. Save the returned `id`, and use the resource URL
from the `Location` header. A request for that user with Beta's valid token
gets `404`. A missing or invalid SCIM token gets `401` on the mounted API.

To manage Riley's existing local membership, link the directory user as
the tenant owner. Riley needs a verified app account and an existing
Alpha membership. Use the same origin the starter is configured to serve.

```http
POST /api/tenants/<alpha-id>/scim/users/<scim-user-id>/bind
Cookie: <owner-session-cookie>
Origin: <browser-origin>
Content-Type: application/json

{"accountId":"<riley-account-id>"}
```

Expect `204 No Content`. The starter enables this owner action for
SCIM-configured tenants. Provisioning an email creates a directory record
and leaves app membership untouched until the owner links it.

With Riley signed in, first confirm that the notes route returns `200`.
Deactivate the linked directory user with Alpha's bearer token.

```http
PATCH /scim/v2/Users/<scim-user-id>
Authorization: Bearer <alpha-scim-token>
Content-Type: application/scim+json

{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}
```

Expect `200` with `active: false`. Retry the Alpha notes request with
Riley's same session and expect `404`. If Riley is also a Beta member,
confirm Beta's notes still return `200`. The adapter revokes the linked
Alpha membership and its authorization relationships together.

[SAML and production setup](../../../apps/kit-workbench/DEPLOY.md#enable-enterprise-identity) ·
[SCIM HTTP test](../../../apps/kit-workbench/tests/enterprise-scim.integration.test.ts) ·
[Linked-membership test](../../../packages/server/tenants/src/tenant-scim.integration.test.ts)
