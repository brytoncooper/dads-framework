# Dads starter

This project runs a browser workbench, a Fastify API, and PostgreSQL.
Create an account, start a workspace, and add notes. Workspace owners and
administrators can invite collaborators. The customer API serves notes and
their feature state. The staff API selects tenant routes.

## Start

With Node 24, npm, and Docker running, execute `npm start` from this project.
Open the workbench URL printed by the command. Use `npm run dev:status`
to look up the URL and `npm run dev:down` to stop the stack. See
[local development](./assembly/LOCAL-DEV.md) for ports, logs, and restart commands.

In the browser, select **Create an account**. Run `npm run dev:mail` in a second
terminal and open your verification link, then sign in. Create a workspace and
add a note. The notes panel reads the active workspace's feature state and
offers CSV and PDF downloads when the notes export flag is enabled.
To invite someone, open **Invite a collaborator** and enter their email. Run
`npm run dev:mail` again to find the invitation link. The invitee can open it,
sign up or sign in with that verified email, then select **Accept invitation**.

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

## Call the customer API from the command line

```sh
base=http://127.0.0.1:5173
read -rs password
signup=$(jq -cn --arg password "$password" \
  '{email:"local@example.test",name:"Local user",password:$password}')
curl -fsS "$base/api/auth/sign-up/email" -H "Origin: $base" \
  -H 'Content-Type: application/json' -d "$signup"
```

Open the `verify-email` link from the local server terminal. Sign in with
the same email and password, then create a tenant and a note.

```sh
signin=$(jq -cn --arg password "$password" \
  '{email:"local@example.test",password:$password}')
curl -fsS "$base/api/auth/sign-in/email" -H "Origin: $base" \
  -H 'Content-Type: application/json' -c .dads-cookies -d "$signin"
tenant=$(curl -fsS "$base/api/tenants" -b .dads-cookies \
  -H 'Content-Type: application/json' -d '{"name":"First workspace"}' | jq -r .data.id)
curl -fsS "$base/api/tenants/$tenant/notes" -b .dads-cookies \
  -H 'Content-Type: application/json' -d '{"text":"My first note"}'
curl -fsS "$base/api/tenants/$tenant/notes" -b .dads-cookies
```

Membership guards each notes route. SQL reads and writes carry the same tenant
key. An account without membership gets a 404 even if it knows the tenant ID.

Protected writes recheck the same permission inside the serializable
transaction that writes the row. Generated resource updates use the same
`writeWithPermission` service. Related access changes can use the authorization
port passed to the write callback so they commit or roll back with the row.
A revocation committed before the write's permission snapshot denies the write.
If they overlap, PostgreSQL can serialize either change first.
If the database cannot serialize a write, the API returns a retryable
`POSTGRES_CONFLICT` (HTTP 409). Reads retain their ordinary permission check.

## Invite someone to a tenant

A tenant owner or administrator can send an invitation from a signed-in session.

```sh
curl -fsS "$base/api/tenants/$tenant/invitations" -b .dads-cookies \
  -H "Origin: $base" --json '{"email":"collaborator@example.test"}'
```

The mail contains a link with the token in its fragment. A recipient with an
existing account signs in with the same verified email. A new recipient signs
up and verifies that email first. For this command-line starter, save the
recipient's session to `.dads-recipient-cookies`, then submit the token from the
mail fragment.

```sh
read -rs token
printf '%s\n' "$token" | jq -Rn '{token:input}' | \
  curl -fsS "$base/api/tenants/invitations/accept" -b .dads-recipient-cookies \
    -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @-
unset token
```

Invitations are single-use and expire after seven days. Use terminal mail only
with the local development flag. In deployed apps, deliver invitation messages
through a confidential mail transport.

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
