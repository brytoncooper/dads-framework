# Inspect a workspace member's permissions

## How the starter implements it

[apps/web/permissions-dashboard.tsx](../apps/web/permissions-dashboard.tsx)
loads the active workspace's roster and displays the selected account's
effective permissions. The customer API registers the route in
[domains/tenants/server/permission-routes.ts](../domains/tenants/server/permission-routes.ts).
Its `access` guard requires `manage_members` on the workspace in the URL.
The handler passes the authenticated caller, workspace, and selected account
to the tenant service.

<!-- dads:excerpt {"path":"domains/tenants/server/permission-routes.ts","language":"ts","from":"const access = requires(","through":");"} -->

<!-- dads:excerpt {"path":"domains/tenants/server/permission-routes.ts","language":"ts","from":"      route: memberPermissionsRoute,","through":"        ),"} -->

## Try it

With Docker running, start the generated project and prepare the example accounts:

```sh
npm start
npm run examples:setup
```

1. Sign in at the workbench URL as the example owner. Find the local
   credentials in `.dads/examples/accounts.json`.
2. Choose the workspace named **Examples …**, open **Permissions**, and
   select the member. The dashboard shows **Member**, with **View workspace**
   allowed and **Manage members** and **Manage workspace settings** denied.
3. Sign in as the example member in a separate browser profile. You can
   open the workspace and view its notes. The outsider account cannot
   open the workspace.

Run `npm test -- tests/starter.integration.test.ts` from the generated
project to check the API responses. The [permission assertions](../tests/permissions-dashboard.test-support.ts)
show HTTP 200 for the owner's inspection and HTTP 404 for the same request
from an ordinary member or an outsider.
