# Dads vocabulary

## Where does the workspace ID show up in the API?

The starter calls it a **workspace** in the browser and a **tenant** in
the API. The workspace picker selects a tenant ID, and Notes uses it in
`/api/tenants/:tenantId/notes`. When tracing a workspace bug, follow the
same ID from the picker through the route to the database query.
[Workspace picker](../../../apps/kit-workbench/apps/web/workspace-controls.tsx) ·
[Notes routes](../../../apps/kit-workbench/domains/notes/server/routes.ts)

## I added a route to a plugin. Which API serves it?

Check where the plugin is **mounted**. The HTTP **kit** supplies route
builders. The Notes **plugin** contributes the built routes to a host.
The customer app selects that plugin in its `routes` array, so the same
Notes URL returns 404 on the staff app. The attachment worker is a
separate plugin selected under `jobs`.
[Compose APIs and plugins](./composition.md) ·
[Customer app](../../../apps/kit-workbench/apps/customer/app.ts)

## Can I delete the `// dad:add domains` comment?

Leave it where you want the generator to insert a plugin. The comment is
an edit marker for the CLI. The actual entry in the API’s `routes` array
is what serves requests. From the starter, preview
`npx dad add domain inventory --api staff --dry-run --json` to see the
planned files. Omitting `--api staff` creates the domain without mounting
it in an API. [Generator guide](../../../docs/generators.md).

## Which Workbench has the Notes starter?

The Notes starter comes from `apps/kit-workbench`. **Workbench** also
names the separate reference task API in `apps/workbench`.
`npm run workbench:dev` from the framework checkout starts that task API.
Follow Quickstart to run the Notes UI.
[Quickstart](./quickstart.md) ·
[Reference Workbench](../../../apps/workbench/README.md)

## Why does Notes use a permission handle and a permission name?

`tenantAccess.tenant.permissions.view` is the **handle** exported by the
tenant access model. The Notes route declaration reads the **wire names**
from that handle and gets the target ID from `fromParam("tenantId")`.
The write guard takes the handle directly. Follow the handle to find
which relationships grant access.
[Notes access declaration](../../../apps/kit-workbench/domains/notes/access/index.ts) ·
[Tenant permission rules](../../../packages/server/tenants/src/tenant-access.ts)

## If the route checks the tenant, why does the list filter by tenant too?

The permission check answers whether the caller may read the tenant
named in the URL. The list query **scopes** the results to that tenant.
Notes applies the same predicate to the page of rows and its total count.
When changing the query, check both.
[Notes list route](../../../apps/kit-workbench/domains/notes/server/routes.ts) ·
[Add a guarded resource](./guarded-resource.md)

## What does a recommended test task tell me?

`dad test:recommend` reports the tasks selected for a change. In the
starter, a Notes route edit can select `domains-notes`, whose configured
command is `npm run verify`. Read the `dad verify` report to see which
checks ran and their results.
[Verification and code health](./verification.md)
