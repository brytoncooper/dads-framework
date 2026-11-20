# `@dads-framework/authorization`

Keep access decisions tied to the same relationship model across route guards,
list filters, and writes. This package exposes those operations and supplies
a SpiceDB adapter, an outbox, and a fake for tests.

## Try it

```ts
import { FakeAuthorization } from "@dads-framework/authorization/testing";

const auth = new FakeAuthorization();
const resource = { type: "project", id: "p1" };
const subject = { type: "user", id: "u1" };
const query = { resource, subject, permission: "viewer" };

console.log(await auth.check(query)); // false
auth.seed({ resource, subject, relation: "viewer" });
console.log(await auth.check(query)); // true
```

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
