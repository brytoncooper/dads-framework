# View a tenant as a member from the staff API

## How the starter implements it

[assembly/staff-impersonation-services.ts](../assembly/staff-impersonation-services.ts)
creates a Postgres-backed grant service and applies the configured tenant's
SSO policy to the staff session. Its authorization callback checks the
operator allowlist and the target account's current ability to view the
workspace. [domains/support/server/impersonation.ts](../domains/support/server/impersonation.ts)
handles the commands; [assembly/start-app.ts](../assembly/start-app.ts)
mounts them on the staff API when enabled.

<!-- dads:excerpt {"path":"assembly/staff-impersonation-services.ts","language":"ts","from":"  const staff = new Set(staffAccountIds);","through":"    );"} -->

## Try it

Run the staff impersonation test from the generated project with Docker running:

```sh
npm test -- tests/staff-impersonation.integration.test.ts
```

[The test](../tests/staff-impersonation.integration.test.ts) starts the
customer and staff APIs with a temporary database. An approved staff
session receives HTTP 201 when it starts a grant. Viewing the tenant with
the grant returns HTTP 200 with both account IDs and the tenant. A second
session for that staff account gets HTTP 404. Stop the grant from its
original session and the next view also gets HTTP 404. The audit entries
record the authorized and denied attempts.

See [staff support impersonation](../DEPLOY.md#staff-support-impersonation)
for the configuration and request fields for a running app.
