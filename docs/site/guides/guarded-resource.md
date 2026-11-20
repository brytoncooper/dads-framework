# Add a guarded resource

The starter's notes are scoped to a workspace. Try the existing list before
scaffolding a resource of your own.

## Read as a member and as an outsider

Run `npm start` and create and verify two accounts in the workbench.
Use Bash, curl, and jq with the workbench URL printed at startup or by
`npm run dev:status`. Sign in as the future owner first, then as the
account you will keep outside the new workspace.
[Starter setup and sign-in](../../../apps/kit-workbench/README.md#call-the-customer-api-from-the-command-line)

```sh
read -rp 'Workbench URL: ' base
for jar in .dads-cookies .dads-outsider-cookies; do
  read -rp "Verified email for $jar: " email
  read -rsp 'Password: ' password
  printf '\n'
  jq -cn --arg email "$email" --arg password "$password" '{email:$email,password:$password}' |
    curl -fsS "$base/api/auth/sign-in/email" -H "Origin: $base" \
      -H 'Content-Type: application/json' -c "$jar" --data-binary @- >/dev/null
  unset password
done

tenant=$(curl -fsS "$base/api/tenants" -b .dads-cookies \
  --json '{"name":"Field team"}' | jq -er .data.id)
notes="$base/api/tenants/$tenant/notes"
curl -fsS "$notes" -b .dads-cookies --json '{"text":"Check the gate"}'
curl -fsS "$notes?page=1&perPage=10" -b .dads-cookies
curl -sS -i "$notes" -b .dads-outsider-cookies
curl -sS -i "$notes"
```

The member's list returns **200 OK**. The response has a page of records
under `data` and pagination under `meta`. The IDs below are examples.

```json
{
  "data": [
    {
      "id": "6b161f9d-73bc-4a7e-935a-26a57f6a618f",
      "tenantId": "d2453c79-98e2-4c0c-85de-ade0410a01ee",
      "text": "Check the gate"
    }
  ],
  "meta": { "total": 1, "page": 1, "perPage": 10 }
}
```

The signed-in outsider gets **404** with
`{"error":{"code":"RESOURCE_NOT_FOUND","message":"Resource not found"}}`.
The anonymous request gets **401**.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/server/routes.ts", "language": "ts", "from": "    listRoute({", "through": "          db.select({ total: count() }).from(noteTable).where(scope),"} -->

`notesAccess` checks the tenant ID from the URL. The handler applies the
same tenant ID to the record query and the count. This keeps both
`data` and `meta.total` within the authorized workspace.

## Generate your own resource

From an installed starter, preview the files and route placement, then
apply the scaffold.

```sh
npx dad add resource products --api staff --dry-run --json
npx dad add resource products --api staff
```

The scaffold adds list, read, and update operations, an access model, a
migration, and client exports. Apply the migration with `npm run migrate`.
Supply your app's create workflow and seed a product in each of two tenants.
Assert the exact product IDs returned to each tenant, check denial for an
unrelated caller, and check that a caller without management permission
cannot update the product. Run `npm run verify`.
[Starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
