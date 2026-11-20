# Sign in with a company identity provider

Connect a test OIDC provider to an existing workspace. Start in optional
mode so a workspace owner can keep using password sign-in while testing.

## Prepare a workspace and an OIDC client

Run [example setup](./README.md) and keep your terminal in `.dads/examples`.
Use the generated workspace ID as `tenantId`.

```sh
. ./env.sh
printf 'Workspace: %s\n' "$tenant"
printf 'Local callback: %s/api/auth/sso/callback\n' "$web"
```

Use a test OIDC provider and an email domain you control. Register the local
callback printed above if your IdP accepts an HTTP loopback callback. If
it requires a public HTTPS URL, run the pilot on a deployed test instance
and use its workspace ID and public origin, for example
`https://workbench.alpha.example.test/api/auth/sso/callback`. Keep the
browser and its authentication endpoints on the same origin.

Invite an IdP test user to the workspace and have them accept with a verified
email in your company domain. Use an address that the IdP also verifies.

## Configure and prove domain ownership

Copy this JSON into `sso-providers.local.json` in the private
`.dads/examples` directory. Replace the tenant UUID, domain, issuer,
endpoints, client ID, and secret with your test values. For a deployed
instance, supply the JSON through your secret store.

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

For the local stack, run this from `.dads/examples`. It reads the same
private identity key the launcher uses and prints only the DNS record.
For a deployed test instance, use that instance's identity key through the
operator environment instead. Publish the returned `name` and `value` as a
DNS TXT record in the controlled domain.

```sh
export DADS_ENTERPRISE_SSO_PROVIDERS=$(cat sso-providers.local.json)
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { enterpriseSsoDomainChallenge } from "@dads-framework/identity-better-auth";

const { identitySecret } = JSON.parse(readFileSync("../local-dev.json", "utf8"));
const provider = JSON.parse(process.env.DADS_ENTERPRISE_SSO_PROVIDERS)
  .find(({ id }) => id === "sso-alpha");
console.log(enterpriseSsoDomainChallenge(
  identitySecret, provider.tenantId.toLowerCase(), provider.domain
));
JS
```

After the TXT record resolves, apply the provider configuration. The local
launcher can reassign URLs, so refresh the environment and verify the callback
registration still matches the URL.

```sh
npm --prefix ../.. run dev:up
. ./env.sh
printf '%s/api/auth/sso/callback\n' "$web"
```

On a deployed test instance, restart each participating API with the same
tenant policy.

## Check sign-in and workspace access

1. Open the workbench at `$web` in a separate browser profile. Open **Sign in
   with company SSO**, enter `sso-alpha`, and continue through the IdP.
2. Open the workspace and inspect `GET /api/tenants/<alpha-id>/notes` in the Network
   tab. Expect `200` for the member. A signed-in account without workspace
   membership gets `404` on the same path. In local optional mode you can
   compare the generated sessions with:

   ```sh
   curl -sS -i -b owner.cookies "$customer/api/tenants/$tenant/notes"
   curl -sS -i -b outsider.cookies "$customer/api/tenants/$tenant/notes"
   ```

3. If you intend to enforce SSO, change `mode` to `required` after the
   pilot and restart the participating APIs. An existing password session
   gets `401` on the workspace notes route. A member who signs in through
   Alpha's provider gets `200`.

For SAML, use `protocol: "saml"` with `entityId`, `signInUrl`, and
`signingCertificate` (PEM), in place of the OIDC-specific fields. Import
`/api/auth/sso/saml2/sp/metadata?providerId=sso-alpha` into your IdP and
register `/api/auth/sso/saml2/sp/acs/sso-alpha` as the assertion consumer
service. Use public HTTPS URLs for a deployed pilot.
