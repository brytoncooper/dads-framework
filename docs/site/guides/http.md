# HTTP and contracts

Create a note in the starter and inspect the response. Run `npm start`
and create and verify an account in the workbench. Use Bash, curl, and jq
with the workbench URL printed at startup or by `npm run dev:status`.
[Starter setup and sign-in](../../../apps/kit-workbench/README.md#call-the-customer-api-from-the-command-line)

```sh
read -rp 'Workbench URL: ' base
read -rp 'Verified email: ' email
read -rsp 'Password: ' password
printf '\n'
jq -cn --arg email "$email" --arg password "$password" '{email:$email,password:$password}' |
  curl -fsS "$base/api/auth/sign-in/email" -H "Origin: $base" \
    -H 'Content-Type: application/json' -c .dads-cookies --data-binary @- >/dev/null
unset password

tenant=$(curl -fsS "$base/api/tenants" -b .dads-cookies \
  --json '{"name":"Field team"}' | jq -er .data.id)
curl -fsS -i "$base/api/tenants/$tenant/notes" -b .dads-cookies \
  --json '{"text":"Check the gate"}'
```

The server returns **201 Created**. The response wraps the note in `data`.
The IDs below are examples.

```json
{
  "data": {
    "id": "6b161f9d-73bc-4a7e-935a-26a57f6a618f",
    "tenantId": "d2453c79-98e2-4c0c-85de-ade0410a01ee",
    "text": "Check the gate"
  }
}
```

## Declare what crosses the HTTP boundary

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/contract/index.ts", "language": "ts", "from": "export const inTenant = z.object({ tenantId: tenantIdSchema });", "through": "export const inTenant = z.object({ tenantId: tenantIdSchema });"} -->

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/contract/wire.ts", "language": "ts", "from": "export const noteInput = z.object({ text: z.string().trim().min(1).max(2000) });", "through": "export const noteInput = z.object({ text: z.string().trim().min(1).max(2000) });"} -->

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/server/routes.ts", "language": "ts", "from": "    postRoute({", "through": "  ]);"} -->

The HTTP kit parses the tenant ID from the URL and the text from the JSON
body. It checks access to that tenant, passes parsed values to the
handler, and validates the returned note before wrapping it in `data`.
The handler rechecks permission in the transaction that inserts the note.
The route declarations also supply the operation's OpenAPI schemas.

Run the same request with `--json '{"text":"   "}'` and remove `-f` from
the curl options to see **400 VALIDATION_FAILED**. Trimming leaves an empty
string, which fails `noteInput`. Repeat the valid request with a signed-in
account outside the tenant to see **404**, or omit the cookie for **401**.
The starter integration test exercises creation, the subsequent list,
and both read denials.
[Starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
