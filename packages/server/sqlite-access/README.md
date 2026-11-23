# `@dads-framework/sqlite-access`

Check permissions, list accessible resources, resolve transitive subjects, and commit relationship changes alongside business data in SQLite.

## Why SQLite

Sometimes the whole application fits on one machine or inside an embedded store, and adding a separate authorization cluster creates more moving parts than the product has. Keep relationship facts next to application rows, verify access inside the same `BEGIN IMMEDIATE` write transaction, and drop the outbox.

The adapter runs on Node.js built-in `node:sqlite` (`DatabaseSync`) with zero native addons. Callers can also wrap `better-sqlite3`, Drizzle SQLite, or libSQL behind the `SqliteExecutor` port.

## Try it

Use Node.js 22.5 or later. Install the packages and run the script against an in-memory SQLite database.

```sh
npm install @dads-framework/access @dads-framework/sqlite-access
npm install -D tsx
```

Save as `check-sqlite-access.mts` and run `npx tsx check-sqlite-access.mts`.

<!-- dads:check-example -->

```ts
import { DatabaseSync } from "node:sqlite";
import { actor, compileAccess, resource } from "@dads-framework/access";
import { createAccessClient } from "@dads-framework/access/runtime";
import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
  withProtectedSqliteTransaction,
} from "@dads-framework/sqlite-access";

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
      roles: { assignee: user },
      can: ({ assignee }) => ({ edit: assignee }),
    },
  },
});
const model = compileAccess([organization]);

const database = new DatabaseSync(":memory:");
try {
  database.exec(sqliteRelationshipSchemaMigration.sql);
  const executor = createNodeSqliteExecutor(database);
  const authorization = new SqliteAuthorization({
    model,
    namespace: "app",
    executor,
  });
  const access = createAccessClient(authorization);

  console.log(await access.can(user("alice"), organization.task("task-1").view));
  await withProtectedSqliteTransaction({ executor, authorization }, async ({ authorization: scoped }) => {
    const txAccess = createAccessClient(scoped);
    await txAccess.add(user("alice"), organization("org-1").member);
    await txAccess.add(organization("org-1"), organization.task("task-1").organization);
  });
  console.log(await access.can(user("alice"), organization.task("task-1").view));
  await access.remove(user("alice"), organization("org-1").member);
  console.log(await access.can(user("alice"), organization.task("task-1").view));
} finally {
  database.close();
}
```

The script prints `false`, `true`, and `false` as organization membership is granted and revoked while `task` inherits `view` from `organization`.

## Protected writes

Use `withProtectedSqliteTransaction({ executor, authorization, now }, work)` when an authorization check guards a write. The helper runs `BEGIN IMMEDIATE`, pins one `nowMs` snapshot for the transaction, and passes `{ executor, authorization }` bound to that transaction.

Check permissions again inside the callback (using `createAccessClient(authorization)` or `authorization.check(...)`) and perform both business table writes and relationship updates through the scoped handles. Both handles expire as soon as the callback returns or throws. On error, the helper rolls back both application rows and relationship changes.

## Use it

Apply `sqliteRelationshipSchemaMigration.sql` (or iterate `sqliteRelationshipSchemaMigration.statements`) during application startup or migrations. The schema creates `dad_authorization_relationship` along with its reverse subject lookup index and partial expiration index. Wrap `SqliteAuthorization` with `createAccessClient(authorization)` from `@dads-framework/access/runtime` for typed `add`, `remove`, `can`, `list`, `whoCan`, and `listDirect` calls.

To evolve stored relationships across model revisions, use `runSqliteAccessMigrations` and `assertAccessMigrationsUpToDate` from [`@dads-framework/spicedb-access/migration`](../spicedb-access/README.md).

`SqliteAuthorization` compiles `@dads-framework/access` models into parameterized SQLite queries covering:

- Direct relations, nested and cyclic `team#member` subject sets, and wildcards (`user:*`).
- Compiled SQL list filters (`compileFilter({ subject, permission, idColumn, scopeColumns?, now? })`) accepting either a typed `PermissionToken` (`document.permissions.view`) or explicit `{ permission, resourceType }` strings, returning `{ sql, values }` (`EXISTS` or `IN (WITH RECURSIVE ...)`) for single-query paginated and sorted SQLite `SELECT` statements. Pass `scopeColumns: "auto"` to derive parent FK mappings automatically from `columnRelations`.
- Column-backed relations (`columnRelations`): bind single-target FK relations directly to columns on SQLite application tables (`documents.org_id`, `folders.parent_id`, `documents.owner_id`) so authorization reads them directly with zero dual-writes (`NULL` means absent). `writeRelationships` and `deleteRelationships` refuse manual mutations on column-backed relations. Call `await authorization.verifyColumnRelations()` at startup to verify live columns and index presence, and generate reverse-lookup index DDL with `sqliteColumnRelationIndexSql(bindings)`.
- Expiring relationships (`expires_at` epoch milliseconds) evaluated consistently at a single timestamp across reads and updated via upsert.
- Polymorphic arrows across multiple direct target entity types (`parents: [organization, folder]`).
- Recursive monotonic arrows (nested folders with `recursive: true`) with cycle termination on cyclic graph data.
- Transitive `lookupSubjects` returning concrete subject IDs and `hasWildcard`.
- Intersection arrows (`every()` / `.all()`) requiring at least one active target and satisfaction across every active target.

## What it refuses to do

Compilation rejects missing relation or permission targets, empty expressions, local permission self-cycles, non-monotonic recursive cycles through `.unless()` or `every()`, and non-linear recursive intersections.

Permission checks, resource lookups, and `compileFilter` require a concrete subject (`id` cannot be empty or `*`, and `relation` must be omitted), and `compileFilter` rejects invalid `idColumn` identifiers. Relationship writes reject unknown relations, mismatched subject types, empty identifiers, and invalid `expiresAt` dates. Scoped transaction handles reject all calls after the transaction callback ends.

## Contract

`SqliteAuthorization` extends `Authorization` and implements `check`, `checkMany`, `checkEach`, `lookupResources`, `lookupSubjects`, `compileFilter`, `writeRelationships`, `deleteRelationships`, `relationshipExists`, `listDirectSubjects`, `applyChanges`, and `inTransaction`.

Unknown permission names return `false`, `[]`, or `{ subjects: [], hasWildcard: false }`. Successful writes and deletes return an empty consistency token because SQLite reads observe committed writes directly. Database connection lifecycle and migration execution remain application-owned.

## Testing (`@dads-framework/sqlite-access/testing`)

Use `createSqliteTestAuthorization(model)` to open a disposable `:memory:`
SQLite database with the relationship table, covering indexes, and a
`ControllableClock` already installed (`using testEnv = createSqliteTestAuthorization(model)`).
Pair it with `proveAccess(model, { authorization: testEnv.authorization, clock: testEnv.clock }, ...)`
from `@dads-framework/access/testing` and `proveSqliteFilterParity(...)` to
verify that `compileFilter` and `compileFilter({ scopeColumns })` select the
exact same rows as `lookupResources` for every subject.
