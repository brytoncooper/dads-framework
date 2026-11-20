# Permissions are relationships

In the starter, an account can read a workspace's notes when it has the
owner, admin, or member relationship to that particular tenant. The tenant
access model defines which relationships grant each permission.

<!-- dads:excerpt {"path": "packages/server/tenants/src/tenant-access.ts", "language": "ts", "from": "    permissions: (roles) => ({", "through": "    }),"} -->

The notes route uses the exported `view` permission. For
`GET /api/tenants/:tenantId/notes`, `fromParam("tenantId")` tells the
HTTP kit which tenant to check against the caller's session account.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/access/index.ts", "language": "ts", "from": "export const notesPermission = tenantAccess.tenant.permissions.view;", "through": "};"} -->

## Check the same account before and after it joins

Run the member and outsider requests in the guarded resource example first.
Use `collaborator@example.test` as the outsider's verified email. Reuse
`base`, `tenant`, and the cookie jars from that shell.
[Member and outsider setup](./guarded-resource.md#read-as-a-member-and-as-an-outsider)

```sh
notes="$base/api/tenants/$tenant/notes"
curl -sS -i "$notes" -b .dads-outsider-cookies
curl -fsS "$base/api/tenants/$tenant/invitations" -b .dads-cookies \
  -H "Origin: $base" --json '{"email":"collaborator@example.test"}'
```

The first request returns **404**. The second returns **201** and sends an
invitation. Copy its token from the fragment of the link in the development
mail log, then paste it at the silent prompt.

```sh
read -rs token
printf '%s\n' "$token" | jq -Rn '{token:input}' | \
  curl -fsS "$base/api/tenants/invitations/accept" -b .dads-outsider-cookies \
    -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @-
unset token
curl -fsS -i "$notes" -b .dads-outsider-cookies
```

Acceptance returns `{"data":{"tenantId":"<workspace ID>"}}`. The same
notes request now returns **200** with `data` and pagination `meta`.
The account and URL stayed the same. Accepting the invitation added the
membership relationship the permission checks.
[Starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
