# Add a guarded resource

In the generated app, a Notes request authorizes the tenant named in the URL.
[`domains/notes/access/index.ts`](../../../apps/kit-workbench/domains/notes/access/index.ts)
uses the tenant model's `view` permission and resolves the resource ID from
the route's `tenantId` parameter.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/access/index.ts", "language": "ts", "from": "export const notesPermission = tenantAccess.tenant.permissions.view;", "through": "};"} -->

## Scope the records and their count

[`domains/notes/server/routes.ts`](../../../apps/kit-workbench/domains/notes/server/routes.ts)
sets `access: notesAccess` on the list. Its query applies the same tenant
predicate to the rows and the count. The response contains the requested
page under `data` and its total under `meta.total`.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/server/routes.ts", "language": "ts", "from": "    listRoute({", "through": "          total: totals[0]?.total ?? 0,\n        };\n      },\n    }),"} -->

## Prove denial with a signed-in outsider

[`tests/starter.integration.test.ts`](../../../apps/kit-workbench/tests/starter.integration.test.ts)
creates Alpha and Beta in separate workspaces. Alpha reads Alpha's notes.
Beta can read Beta's workspace, then gets **404** when requesting Alpha's
workspace using the same signed-in session. An anonymous request gets **401**.

<!-- dads:excerpt {"path": "apps/kit-workbench/tests/starter.integration.test.ts", "language": "ts", "from": "        const betaRead = await customer.inject({", "through": "        ).toBe(401);"} -->

Run it from the generated app with Docker running. The test starts its own
PostgreSQL container.

```sh
npm test -- tests/starter.integration.test.ts
```

## Scaffold another resource

Preview the files and API placement from the generated app, then rerun
without the preview flags to write them.

```sh
npx dad add resource products --api staff --dry-run --json
npx dad add resource products --api staff
```

The scaffold adds list, read, and update operations, access declarations, a
migration, and client exports. Apply the migration with `npm run migrate`.
Add your app's create workflow and test with a product in each of two
tenants. Assert each tenant's returned IDs and count, then prove denial for
a caller outside the tenant and for updates by a caller without management
permission. Run `npm run verify`.
