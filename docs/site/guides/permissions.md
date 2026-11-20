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

From the generated project, run this test with Docker running:

```sh
npm test -- tests/starter.integration.test.ts
```

The test creates Alpha and Beta in separate workspaces. Beta gets **404**
when requesting Alpha's notes. Alpha invites Beta by email, and Beta accepts
the invitation. The same signed-in account can then make the same request
and get **200**. Accepting the invitation adds the membership relationship
the permission checks.
[Read the starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
