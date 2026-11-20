# Dads starter

This project runs a browser workbench, a Fastify API, and PostgreSQL.
Create an account, start a workspace, and add notes. Workspace owners and
administrators can invite collaborators. The customer API serves notes and
their feature state. The staff API selects tenant routes.

## Start

With Node 24, npm, and Docker running, execute `npm start` from the generated
project. Open the workbench URL printed by the command. Use `npm run dev:status`
to look up the URL and `npm run dev:down` to stop the stack. See
[local development](./assembly/LOCAL-DEV.md) for ports, logs, and restart commands.

In the browser, select **Create an account**. Run `npm run dev:mail` in a second
terminal and open your verification link, then sign in. Create a workspace and
add a note. The notes panel reads the active workspace's feature state and
offers CSV and PDF downloads when the notes export flag is enabled.
To invite someone, open **Invite a collaborator** and enter their email. Run
`npm run dev:mail` again to find the invitation link. The invitee can open it,
sign up or sign in with that verified email, then select **Accept invitation**.

Open **Permissions** for the active workspace and select a member by account ID.
The dashboard shows the member's role and checks whether they can view the
workspace, manage members, or manage workspace settings. Owners and admins can
inspect members of workspaces where they have membership management permission.

With enterprise SSO configured, expand **Sign in with company SSO** on the
sign-in form. Enter the provider ID supplied by your workspace administrator.
The browser returns to the workbench after your identity provider completes
sign-in.

Workspace owners can download audit metadata from the staff API at
`GET /api/tenants/{tenantId}/audit-log/export`. Send an authenticated session
cookie. The response is an NDJSON attachment with up to 100 rows by default.
Pass `pageSize` between 1 and 500 and follow the `Link` header with `rel="next"`
to resume. The endpoint rechecks the tenant permission for each page.

Approved staff can use a short-lived grant to inspect a tenant through a
member's view permission. The [staff impersonation setup](./DEPLOY.md#staff-support-impersonation)
defines who can issue and revoke grants and where to review attempts.

## Try the feature examples

Open **Examples** in the web app for implementation walkthroughs and runnable
tests. Try the permissions dashboard to compare what the owner, a member, and
an outsider can see. [Browse the starter examples](./examples/README.md)

## Run against your own database

For API development with an existing test database, set the browser origin
as the API's base URL so email links and the browser session use the same host.

```sh
npm install
export DATABASE_URL='postgres://localhost:5432/dads'
export DADS_IDENTITY_SECRET="$(openssl rand -hex 32)"
export DADS_DEV_LOG_MAIL=1
export DADS_BASE_URL=http://127.0.0.1:5173
npm run migrate
npm run start:api
```

In a second terminal, run `npm run dev:web` and open
`http://127.0.0.1:5173`. The frontend forwards `/api` requests to
`http://127.0.0.1:3000`. Set `DADS_DEV_API_URL` if the API uses another address.
Set `DADS_API=staff` and choose a separate `PORT` to run the staff API alongside
the customer API.

Set `DADS_PREPARE_PERMISSION_CHECKS=1` to reuse PostgreSQL plans for permission
checks when the app connects directly to PostgreSQL. The default is off.
Leave it off when the connection uses transaction pooling.

## Test the customer API

From the generated project, run this test with Docker running:

```sh
npm test -- tests/starter.integration.test.ts
```

The test starts a temporary PostgreSQL database and signs in two accounts.
Expect a passing test that creates a note with HTTP 201, reads it with HTTP
200, and gets HTTP 404 when the other account requests the same workspace.
An anonymous request gets HTTP 401.
[Read the integration test](./tests/starter.integration.test.ts)

Membership guards each notes route. SQL reads and writes carry the same tenant
key.

Protected writes recheck the same permission inside the serializable
transaction that writes the row. Generated resource updates use the same
`writeWithPermission` service. Related access changes can use the authorization
port passed to the write callback so they commit or roll back with the row.
A revocation committed before the write's permission snapshot denies the write.
If they overlap, PostgreSQL can serialize either change first.
If the database cannot serialize a write, the API returns a retryable
`POSTGRES_CONFLICT` (HTTP 409). Reads retain their ordinary permission check.

The same test exercises invitations. A signed-in account can read the
workspace's notes after accepting the invitation sent to its verified email.
Invitations are single-use and expire after seven days. Use confidential mail
delivery in deployed apps.

## Add a domain

Each entrypoint selects its surfaces in `apps/<api>/app.ts`. Keep contracts,
access rules, and server code together under `domains/<name>/`. Register the
domain's migration source in `assembly/migrations.ts`. Test the selected route
with a member and a nonmember. Run `npm run verify` before installing a CI
provider from `ci/`.

The push hook reuses a passing receipt for the same commit and comparison base.
When proof is missing, it installs dependencies and verifies in a detached checkout.

## Deploy

Follow [run the starter outside development](./DEPLOY.md) for migrations,
runtime settings, and smoke checks. To export traces, set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Tracing stays off without an endpoint.
