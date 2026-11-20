# `@dads-framework/access`

Define relationship-based permissions in TypeScript. Use the composed model
to enforce permissions, generate a SpiceDB schema, or build scoped lists.

## Try it

```ts
import {
  access,
  accessModel,
  emitZed,
  entityHandle,
} from "@dads-framework/access";
import { z } from "zod";

const user = entityHandle({ wireName: "user", idSchema: z.string() });
const team = entityHandle({
  wireName: "team",
  idSchema: z.string(),
  kind: "scope",
});
const teamAccess = access(team, {
  roles: { member: user },
  permissions: (roles) => ({ view: [roles.member] }),
});
const userAccess = access(user, { roles: {}, permissions: () => ({}) });

const model = accessModel([userAccess, teamAccess]);
console.log(emitZed(model));
```

The output includes `permission view = member` on the team definition.
In a service using this model, test a team member and a user with no member
relationship. The first should see the team's records. The second should
receive a denial or an empty scoped list, according to the operation.

## Use it

Define handles and permissions in the packages that own them. At application startup, pass their declarations and optional `scopeBindings` to `accessModel`. The model resolves permission expressions after the declaration modules have loaded. Use the same model for schema generation, route registration, and record lookup guards.

For permissions that customers may grant, `grantable` takes the app's scope names and direct subject handle. Use `membersOf` to declare an optional group subject. Use `lifecycleTrigger(name)` to name a grant removal event. The application handles the event and removes the grant.

## What it refuses to do

Composition rejects duplicate entity names or scope bindings for an omitted definition. A scope plan with an unbound role or cyclic traversal fails to compile.

## Contract

`emitAccessIr(model)` returns plain data and `emitZed(model)` produces SpiceDB schema text. `checkAccessConformance(model.definitions)` checks grant metadata and grant requirements. `checkScopeBindings(model)` checks the default `view` permission of each bound record.

Permission expressions support relationship traversal, unions, intersections, and exclusions. Contextual conditions and SpiceDB caveats are outside the compiler's supported syntax.

### Checking a committed SpiceDB schema

If your project commits generated Zed, compare that artifact with the output of
its current composed model in your schema-generation test. The artifact writer
recognizes a Zed file by the exact first line emitted by this kit.

```ts
expect(readFileSync(schemaPath, "utf8")).toBe(emitZed(model));
```

Run the test in CI. Doctor's generated-access check covers edits in Git history.
The test checks the file against the model. Apps that emit directly to SpiceDB
or run the Postgres adapter need no checked-in Zed file.

### Enforcing access in Node

Use `@dads-framework/access/runtime` for the authorization port, route decisions,
scope answers, and request-local consistency. The runtime entry point keeps
Node request context separate from the model and emitters. Supply a concrete
authorization provider when composing a server. The [Postgres adapter](../server/postgres-access/README.md)
uses the model with relationship facts in the application database. Use its
protected transaction helper when a permission decision guards a business
write in that database. Tests can use `@dads-framework/access/testing` for
in-memory calls and recorded answers.

Schema migration runners can use `@dads-framework/access/schema` to plan and
apply a Zed schema through a supplied store. The authorization package binds
that work to SpiceDB and supplies the Postgres outbox, catalog queries, and
optional datastore snapshots.
