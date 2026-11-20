# Upgrade a Dads project

Check the target release's package README and generated API reference before
updating dependencies. Keep the starter's first-party Dads packages on the
same release version and review the manifest and lockfile diff. Save a
passing `npm run verify` result before the upgrade so you can compare failures.

## Check contracts and consumers

In the reference Workbench, the list-workspaces route declares
`workspaceResponse` as each response item. When an upgrade affects that
contract, regenerate the client and compare the affected operation and
schema with the previous version. The client parses each item with the
same schema. [Workspace route](../../../apps/workbench/src/routes.ts) ·
[Generated client](../../../apps/workbench/src/client.generated.ts)

```sh
npm run workbench:generate
git diff -- apps/workbench/src/client.generated.ts apps/workbench/src/contracts.ts
npm test -w @dads-app/workbench
```

These commands run from the framework checkout. In your app, use its own
client generation and consumer-test commands. If a field is added to an
existing schema, the generated source can stay the same because it imports
the schema. Review the schema diff and exercise the caller that reads the
field.

## Rehearse database and access changes

Run pending migrations against a restored test database before switching
traffic. Keep applied migration files intact. In the starter, point
`DATABASE_URL` at that test database and run `npm run migrate`. Then run
`npm run verify` with Docker running.

Smoke-test the deployed candidate with a member and a signed-in account
outside the tenant. A member can list notes on the customer API. The second
account gets a 404, and the staff host returns 404 for the same route even
when the member makes the request.
[Starter deployment checks](../../../apps/kit-workbench/DEPLOY.md#start-and-check)

## Move from earlier source checkouts

If your source branch split tables, forms, display, and shell components
across packages, move those imports to the current `@dads-framework/ui`
subpaths. For example, import `Input` from `@dads-framework/ui/forms`.
Update the dependency declarations with the imports and rerun the affected
form and table tests. [UI package reference](../../../packages/web/ui/README.md)
