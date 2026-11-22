# `@dads-framework/access`

Define relationship-based permissions in TypeScript. Compile your model once to
enforce permissions in PostgreSQL, SQLite, or SpiceDB, render an access tree,
or generate a `.zed` schema.

## Try it

In the generated starter, [`libraries/app-runtime/index.ts`](../../apps/kit-workbench/libraries/app-runtime/index.ts)
defines account and tenant access handles shared by the domains.
[`assembly/start-app.ts`](../../apps/kit-workbench/assembly/start-app.ts) composes the selected API's declarations into one
model before opening its services.

Use Node.js 22 or later. This example compiles a top-down hierarchy, prints the
resolved permission tree, and emits SpiceDB `.zed` text locally with no
database required.

```sh
npm install @dads-framework/access
npm install -D tsx
```

Save as `access-model.mts` and run `npx tsx access-model.mts`.

<!-- dads:check-example -->

```ts
import {
  actor,
  anyOf,
  compileAccess,
  emitZed,
  formatAccessTree,
  resource,
} from "@dads-framework/access";

const user = actor("user");

const organization = resource("organization", {
  roles: { admin: user, member: user },
  can: ({ admin, member }) => ({
    manage: admin,
    view: [admin, member],
  }),
  children: {
    task: {
      inherit: "all",
      roles: { assignee: user, blocked: user },
      can: ({ assignee, blocked, parent }) => ({
        edit: anyOf(assignee, parent.manage).unless(blocked),
      }),
    },
    billing: {
      inherit: ["manage"],
      roles: { accountant: user },
      can: ({ accountant }) => ({ view: accountant }),
    },
  },
});

const model = compileAccess([organization]);
console.log(formatAccessTree(model));
console.log(emitZed(model));
```

The output prints the resolved inheritance tree (`organization -> task`,
`billing`) followed by SpiceDB `.zed` definitions where `task` inherits
`organization->view` and `organization->manage`, while `billing` inherits only
`manage` and stays fail-closed on every other parent permission.

In a service using this model, test an authorized member and a user with no
relationship. The first sees the resource; the second receives a denial or an
empty list, according to the operation.

## Use it

Declare actors with `actor(name)` and resources with `resource(name, spec)`.
Nest child resources inline under `children` or split them into separate files
with `parent.child(name, spec)`. Every child declares `inherit` explicitly
(`"all"`, `"none"`, or a list of parent permission names such as `["manage"]`).
Use `parents: [organization, folder]` for multi-parent DAGs and `recursive: true`
for self-nested folders.

At application startup, pass the root resources to `compileAccess([organization])`.
`compileAccess` auto-discovers inline `children`, `.child()` branches, `parents`,
lazy thunks, and actors into one `AccessModel`. Use `compileAccessFromIr(definitions)`
to lower parsed `.zed` IR directly into an `AccessModel`. Use the same compiled
model for PostgreSQL, SQLite, SpiceDB `.zed` generation, and route guards.

Optional subpaths keep advanced features out of the core API:

- **`@dads-framework/access/catalog`:** Exports `grantable`, `lifecycleTrigger`,
  `catalogOnly`, `checkAccessConformance`, and `missingGrantingAdvisories` for
  customer-assignable role editors and lifecycle governance.
- **`@dads-framework/access/scopes`:** Exports `scopeBindings`, `compileScopePlan`,
  `checkScopeBindings`, `isSparseDirectGrant`, and `isLookupResourcesAllowed` for
  fail-closed SpiceDB scoped list planning (`allowLookupResourcesOn` and `bindings`
  on `compileAccess`).

## What it refuses to do

Compilation rejects duplicate entity names, missing inherited parent permission
names, cyclic parent inheritance, and scope bindings for an omitted definition.
A scope plan with an unbound role or cyclic traversal fails to compile.

## Contract

`compileAccess(nodes, options?)` builds an `AccessModel`, `compileAccessFromIr(definitions, options?)`
lowers parsed IR into an `AccessModel`, `formatAccessTree(model)` renders a
deterministic ASCII tree with `[inherited]`, `[inherited+local]`, and `[local]`
tags, `emitAccessIr(model)` returns plain IR data, and `emitZed(model)` produces
SpiceDB schema text. `emitTypeScript(definitions)` and `emitTypeScriptFromZed(zed)`
compile access IR or SpiceDB `.zed` text into ergonomic Dads TypeScript
declarations. `checkAccessConformance(model.definitions)` checks grant metadata
and requirements. `checkScopeBindings(model)` checks the default `view`
permission of each bound resource.

Permission expressions support unions (`anyOf` / `.or()` / arrays),
intersections (`allOf` / `.and()`), exclusions (`.unless()`), parent traversal
(`parent.view` / `parents.view`), and universal intersection arrows
(`every(link).approve`, emitted as `.all()`). Use `user.expiring` for expiring
grants, `user.anyone` for wildcards, and `team.roles.member` for usersets.
Contextual conditions, SpiceDB caveats, and `nil` are outside the compiler's
supported syntax.

### Checking a committed SpiceDB schema

If your project commits generated Zed, compare that artifact with the output of
its current composed model in your schema-generation test. The artifact writer
recognizes a Zed file by the exact first line emitted by this kit.

```ts
expect(readFileSync(schemaPath, "utf8")).toBe(emitZed(model));
```

Run the test in CI. Doctor's generated-access check covers edits in Git history.
The test checks the file against the model. Apps that emit directly to SpiceDB
or run the Postgres or SQLite adapters need no checked-in Zed file.

### Enforcing access in Node

Use `@dads-framework/access/runtime` for:

- `createAccessClient(authorization)`: Symmetric typed runtime client (`add`,
  `remove`, `can`, `list`, `whoCan`, `listDirect`) that enforces allowed subject
  types for every role slot at compile time.
- `ShadowAuthorization`: Dual-writing, shadow-comparing `Authorization` wrapper
  (`mode: "shadow-read" | "primary-new"`) for zero-downtime backend cutover.
- `Authorization`: Base runtime port (`check`, `checkMany`, `lookupResources`,
  optional transitive `lookupSubjects`, `listDirectSubjects`, and relationship
  writes with optional `expiresAt`), route decisions, scope answers, and
  request-local consistency.

The runtime entry point keeps Node request context separate from the model and
emitters. Supply a concrete authorization provider when composing a server. The
[Postgres adapter](../server/postgres-access/README.md) and
[SQLite adapter](../server/sqlite-access/README.md) evaluate the model against
relationship facts in the application database. Use their protected transaction
helpers when a permission decision guards a business write in that database.
Tests can use `@dads-framework/access/testing` for in-memory calls (including
optional `now` clocks for expiring tuples) and recorded answers.

Schema migration runners can use `@dads-framework/access/schema` to plan and
apply a Zed schema through a supplied store. The authorization package binds
that work to SpiceDB and supplies the Postgres outbox, catalog queries, and
optional datastore snapshots.
