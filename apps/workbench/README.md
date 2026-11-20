# Dads Workbench

Run a local reference API for workspaces, membership, tasks, claims,
artifacts, and activity. Business writes and relationship updates share one
Postgres transaction. The Workbench uses the same HTTP and permission
packages as the starter.

## Start

With Node 24 and Docker Compose running, run these commands from the repository
root:

```sh
npm ci
npm run workbench:dev
```

The launcher starts a loopback API on port 4317 and prints its OpenAPI URL.
Use the local demo identities from `GET /api/demo/identities`. For example:

```sh
curl -fsS http://127.0.0.1:4317/api/workspaces \
  -H 'x-workbench-user: alice'
```

The demo header is accepted only for the local host and origin. For
email-and-password sign-in, use the [kit starter](../kit-workbench/README.md).

Stop the process with Ctrl+C or run `npm run workbench:stop`. The database
volume persists across restarts. For an independent experiment:

```sh
npm run workbench:dev -- --instance experiment --port 0
npm run workbench:stop -- --instance experiment
```

On Postgres, the task list looks up visible task IDs, limits them to the
workspace snapshot, and checks workspace access again before returning the
page. The total counts only visible tasks in that workspace. Resource discovery
evaluates the relationship graph on each request.

Protected Postgres writes recheck permission inside the same serializable
transaction as the application write. An overlapping revoke can serialize
after that write.
A concurrent write can return HTTP 409 with code `POSTGRES_CONFLICT` and
`details.retryable: true`. The server does not replay the operation. Refresh
state before sending another request.

## Change and verify the API

- [Route cards](src/routes.ts) choose the HTTP operation and permission.
- [Access model](src/access.ts) defines workspace membership and task access.
- [Operations](src/operations/workbench-operations.ts) enforce the business rules.
- [Store](src/storage/workbench-store.ts) owns persistence.
- [Generated client](src/client.generated.ts) follows the route cards.

```sh
npm run workbench:generate
npm test -w @dads-app/workbench
npm run verify:workbench-postgres-integration
```

Creating workspaces, tasks, and artifacts requires a `requestKey`. Retry the
same action with the same key and body. Claims record state and grant no
permissions. Removing workspace membership hides its tasks, artifacts,
and activity even if the former member previously claimed a task.
