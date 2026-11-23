# `@dads-framework/spicedb-access`

SpiceDB relationship authorization adapter, transactional outbox journal (`/authz-journal`), and bidirectional SpiceDB ↔ PostgreSQL migration tools (`/migration`, `dads-import-spicedb`).

Keep access decisions tied to the same relationship model across route guards,
list filters, and writes. This package exposes those operations and supplies
a SpiceDB adapter, an outbox, and a fake for tests.

## Try it

The generated starter uses Postgres for authorization in
[`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts). For the SpiceDB adapter, see the repository's
[SpiceDB integration test](./src/lib/access/spice-db-authorization.integration.test.ts),
which checks a permitted grant and denies a subject with no relationship.

Use Node.js 22 or later and a fresh local SpiceDB datastore. This example
replaces the datastore's entire schema. The Docker command starts an
ephemeral testing instance with its gRPC port bound to loopback.

```sh
npm install @dads-framework/spicedb-access
npm install -D tsx
docker run --rm -p 127.0.0.1:50051:50051 authzed/spicedb:v1.57.0 serve-testing
```

In another terminal, save this as `check-access.mts` and run
`npx tsx check-access.mts`.

<!-- dads:check-example -->

```ts
import { SpiceDbAuthorization, relationshipWrite } from "@dads-framework/spicedb-access";

const authorization = new SpiceDbAuthorization({
  endpoint: "127.0.0.1:50051",
  presharedKey: "quickstart",
  insecure: true,
  consistency: "fully-consistent",
});

await authorization.writeSchema(`
definition user {}
definition project {
  relation viewer: user
  permission view = viewer
}
`);

const resource = { type: "project", id: "project-1" };
const subject = { type: "user", id: "alice" };
const query = { resource, subject, permission: "view" };

console.log(await authorization.check(query));
await authorization.writeRelationships([relationshipWrite(resource, "viewer", subject)]);
console.log(await authorization.check(query));
```

The first run prints `false` and then `true`. Restart the container to clear
the grant before repeating the example. For unit tests of direct grants, use
`FakeAuthorization` from `@dads-framework/spicedb-access/testing`.

## Use it

Create a `SpiceDbAuthorization` for the application's datastore. Wrap it in `GuardedAuthorization` with the guard thresholds and `authorizationKinds(model)`, using the same model as the HTTP routes. Use `DEFAULT_AUTHORIZATION_GUARD_MARKS` for the default thresholds.

For scoped lists, `planScopedList(model, resourceType, permission)` compiles the scope at startup. `answerScope` looks up the scope IDs for the authenticated caller. Pass the answer, the record's SQL bindings, and any related bindings to `scopePredicate` to build the filter. Use `keepPermitted` to recheck the selected rows.

## What it refuses to do

The guard refuses to enumerate visible IDs for records unless the model declares a sparse direct grant or an active dated exception. The SQL renderer refuses to traverse a record without supplied SQL bindings.

## Contract

`Authorization` provides permission checks, ID lookups, and relationship writes. `RequestSubject` resolves a request's authenticated subject. The testing fake implements direct relationships for unit tests. `WireResourceRef` (also exported as `ResourceRef`) contains the string kind and ID passed to the adapter.

`createApplyAccessChangesAfterCommit` projects a save's own authorization facts after commit. If another worker holds those facts, it briefly polls their status before returning. The durable outbox makes the remaining work replayable.

The authorization client, outbox, and migration helpers use the shared
`@dads-framework/access/runtime` port. Their existing authorization exports are
available for consumers of this package. An HTTP adapter can use the runtime
port without loading a database or SpiceDB client.
