# Export one workspace's audit metadata

## How the starter implements it

[apps/staff/app.ts](../apps/staff/app.ts) mounts the audit export plugin.
[migrations/20261120080000_starter.migration.ts](../migrations/20261120080000_starter.migration.ts)
installs the trigger that records note writes under `tenant_id`.
[domains/tenants/server/audit-export.ts](../domains/tenants/server/audit-export.ts)
uses that same dimension to scope every page and authorizes the authenticated
account before returning the tenant's audit metadata.

<!-- dads:excerpt {"path":"domains/tenants/server/audit-export.ts","language":"ts","from":"        const exportPage = createAuditLogExporter({","through":"              permission: permission.permissionName,"} -->

## Try it

Run the starter integration test from the generated project with Docker running:

```sh
npm test -- tests/starter.integration.test.ts
```

In [the audit assertions](../tests/audit-export.test-support.ts), the owner
asks the staff API for one entry and follows the `Link` header whose relation
is `next`. Both pages return HTTP 200 with one JSON object per line. The
export contains the workspace's note-write metadata and excludes note text
and row snapshots. An ordinary member gets HTTP 404, including when they
reuse the owner's continuation URL. The customer API also returns HTTP 404
for this staff route.

Use [the deployment guide](../DEPLOY.md#start-and-check) to run the staff API
and [the starter README](../README.md#start) for the export URL.
