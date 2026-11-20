# Local development

Use Node 24, npm, and Docker with the Compose v2 plugin. Start Docker before
running the creator. A generated project uses its npm lockfile and a separate
Linux dependency volume for the Compose services.

From the project directory, run `npm install` if the lockfile is missing, then
run `npm start`. The launcher starts PostgreSQL, applies migrations, and
checks both APIs and the customer API through the web frontend. Open the browser
URL it prints. Docker assigns separate loopback ports for the browser and
the two APIs. Each project uses its own ports, database, and persistent
application files.

| Run                   | Result                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `npm run dev:up`      | Start the stack and wait for a healthy browser URL.                    |
| `npm run dev:mail`    | Read verification and invitation messages from the private mailbox.    |
| `npm run dev:status`  | Check the browser and API and report their current URLs.               |
| `npm run dev:down`    | Stop the stack and preserve its data.                                  |
| `npm run dev:restart` | Recreate the containers, apply migrations, and print the current URLs. |

For automation use `npm run --silent dev:up -- --json`. Compose progress goes
to stderr. Its JSON result includes `ok`, `running`, `webUrl`, `apiUrl`, and `staffUrl`
when the stack is ready. Restart can allocate new ports.

The database password and authentication secret are generated once per
project in the ignored `.dads/local-dev.json`. Keep this file with the local
database volume. Store it and the development mailbox privately, because
verification and invitation messages contain sign-in links.

The local job queue runs in the customer API process. Queued jobs can be
lost when that process stops. A deployed app that needs durable jobs should
configure a persistent queue. The development file store and mail spool use
the persistent application volume. Run `npm run dev:mail` from the project to
read the most recent mail. If a message has just been sent, allow a moment for
delivery and run the command again.

The service logs are available through Docker Desktop under the Compose
project associated with this checkout.

## Verify in CI

Commit `package-lock.json`. On a Node 24 runner with Docker, install from the
lockfile and run the starter's checks.

```sh
npm ci
npm run verify
```

The integration suite starts its own disposable PostgreSQL container.

### Preview Notes export for a tenant member

The customer API accepts `DADS_FEATURE_PREVIEW` as an optional JSON setting.
Set it for one account and tenant. The API checks the account's current tenant
permission when it resolves the preview. The request URL selects the tenant.

Generate a random token and put its SHA-256 digest in the JSON setting. Keep
the token for the request header.

```sh
preview_token=$(openssl rand -hex 32)
printf '%s' "$preview_token" | openssl dgst -sha256
```

Set `DADS_FEATURE_PREVIEW` before starting the customer API. Replace the
account ID, tenant ID, digest, and expiry with values for your preview.

```json
{
  "accountId": "your-account-id",
  "tenantId": "00000000-0000-4000-8000-000000000000",
  "feature": "notes.export",
  "active": true,
  "tokenSha256": "<sha256>",
  "expiresAt": "2026-12-01T12:00:00Z"
}
```

Send an authenticated request to
`GET /api/tenants/<tenant-id>/notes/features` with
`x-feature-preview: <token>`. The response's `features` includes
`notes.export`, and the same token works on the tenant's note export URL.
The preview is read-only. Restart the API with the setting removed to revoke
the token before its expiry.
