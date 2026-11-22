# Access & Permissions

Dads splits authorization into two layers: a database-free permission model ([`@dads-framework/access`](../../../packages/access/README.md)) and an execution engine ([`@dads-framework/postgres-access`](../../../packages/server/postgres-access/README.md) for PostgreSQL, [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md) for SQLite, or [`@dads-framework/authorization`](../../../packages/server/authorization/README.md) for SpiceDB).

Your domains import only `@dads-framework/access`. Business logic and unit tests stay database-free, while production checks execute inside your database transactions.

![Transactional PostgreSQL ReBAC flow](../../../website/site/assets/diagrams/postgres-rebac-transaction.svg)

## Core definitions

Every access model uses six building blocks. See [SDK Glossary & Options](sdk-reference.md) for every combinator, adapter option, and CLI flag.

- **Actor (`actor`):** Who takes an action (such as `user` or `service_account`). Call `user("alice")` to reference a concrete actor.
- **Resource (`resource`):** A protected thing in your app (such as `organization`, `task`, or `billing`). Call `task("t1")` to reference a concrete record and its typed role slots or permission targets.
- **Roles (`roles`):** Stored relationships in your database, such as `admin`, `member`, `assignee`, or a parent link.
- **Permissions (`can`):** Actions someone can take, such as `view`, `edit`, or `manage`. Routes check permissions (for example `organization.task.can.edit`), never raw roles.
- **Hierarchy (`children`, `.child()`, and `inherit`):** Nest child resources under a parent and declare explicit inheritance (`"all"`, `"none"`, or a list such as `["manage"]`). Omitted parent permissions stay closed by default.
- **Compiled model & client (`compileAccess`, `createAccessClient`):** `compileAccess([organization])` auto-discovers every child, parent, and actor into one `AccessModel`. `createAccessClient(authorization)` wraps any backend with symmetric typed `add`, `remove`, `can`, `list`, `whoCan`, and `listDirect` methods.

## 1. Declare actors, resources, and top-down inheritance

Define your hierarchy once in TypeScript. Child resources declare `inherit` explicitly so sensitive resources like `billing` or `order` stay fail-closed (`packages/access/src/core/dsl.test.ts`):

<!-- dads:excerpt {"path":"packages/access/src/core/dsl.test.ts","language":"ts","from":"    const user = actor(\"user\");\n\n    const organization = resource(\"organization\", {\n      roles: {\n        admin: user,","through":"          can: ({ accountant }) => ({\n            view: accountant,\n          }),\n        },\n      },\n    });"} -->

Pass the root resources to `compileAccess([organization])` to produce an `AccessModel`, and call `formatAccessTree(model)` to inspect the resolved inheritance tree.

Because `task` declares `inherit: "all"` and `photo` nests under `task`, revoking someone from `organization` revokes their access to every `task` and `photo` inside it. Meanwhile `order` (`inherit: "none"`) and `billing` (`inherit: ["manage"]`) never inherit `organization.edit` or `organization.view`.

Use `.child()` to split large trees across files, `parents: [organization, folder]` for multi-parent DAGs, `recursive: true` for nested folders, and combinators (`anyOf`, `allOf`, `.unless()`, `every(link).perm`) for custom rules.

## 2. Check, grant, and list with `createAccessClient`

Wrap any `Authorization` backend (PostgreSQL, SQLite, SpiceDB, or `FakeAuthorization`) with `createAccessClient(authorization)` from `@dads-framework/access/runtime`. Every `add` and `remove` call enforces allowed subject types at compile time:

| Method                                      | What it does                                                                                               |
| :------------------------------------------ | :--------------------------------------------------------------------------------------------------------- |
| `client.add(subject, slot, { expiresAt? })` | Grants a role or links a parent (for example `client.add(user("alice"), organization("org-1").member)`).   |
| `client.remove(subject, slot)`              | Revokes a direct role or parent link.                                                                      |
| `client.can(subject, target, options?)`     | Returns `true` or `false` (for example `client.can(user("alice"), organization.task("t1").edit)`).         |
| `client.list(subject, permission)`          | Returns all resource IDs the subject can access (for example `organization.task.can.edit`).                |
| `client.whoCan(target, actorHandle)`        | Returns `{ subjects, hasWildcard }` listing everyone who can access a resource, including inherited paths. |
| `client.listDirect(slot)`                   | Lists direct role holders on a single slot for member rosters and last-admin guards.                       |

## 3. Guard writes inside a database transaction

### PostgreSQL (Drizzle-free or Drizzle)

`@dads-framework/postgres-access` works directly on a plain `pg.Pool` with zero ORM requirement (Node.js 22 or later):

```sh
npm install @dads-framework/access @dads-framework/postgres-access pg zod
```

1. Apply `relationshipSchemaMigration.sql` through your migration runner.
2. Create `new PostgresAuthorization({ model, namespace, executor: pool })`.
3. For protected writes, call `withProtectedPgTransaction({ pool, authorization }, async ({ client, authorization: scoped }) => { ... })`. It opens a `SERIALIZABLE` transaction on the checked-out `pg` client, binds `scoped` to that transaction, closes the scope on exit, and maps PostgreSQL `40001` conflicts to `PostgresSerializationConflict`.

If your application uses Drizzle, import `withProtectedDrizzleTransaction` and `transactionExecutor` from `@dads-framework/postgres-access/drizzle`. Existing Dads apps using `@dads-framework/postgres` can continue calling `withProtectedPostgresTransaction` (`assembly/protected-write.ts`):

<!-- dads:excerpt {"path":"apps/kit-workbench/assembly/protected-write.ts","language":"ts","from":"export function createProtectedWrite(","through":"}"} -->

Both the permission check and the business write share one PostgreSQL transaction snapshot. Removing a member and deleting their business rows commit or roll back together, with zero authorization outbox lag.

### SQLite (Node built-in `node:sqlite`)

For local-first, edge, or single-node deployments, install [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md):

```sh
npm install @dads-framework/access @dads-framework/sqlite-access zod
```

Wrap Node's built-in `DatabaseSync` with `createNodeSqliteExecutor(db)`, apply `sqliteRelationshipSchemaMigration.sql`, instantiate `new SqliteAuthorization({ model, namespace, executor })`, and guard writes with `withProtectedSqliteTransaction({ executor, authorization }, work)` inside a `BEGIN IMMEDIATE` transaction with one pinned timestamp.

## 4. Attach permission guards to HTTP routes

Export named permission tokens (such as `organization.task.can.edit`) from `domains/<feature>/access/index.ts` and attach them to routes (`domains/notes/access/index.ts`):

<!-- dads:excerpt {"path":"apps/kit-workbench/domains/notes/access/index.ts","language":"ts","from":"import { fromParam, requires } from \"@dads-framework/http\";","through":"export const notesAccess = requires(notesPermission, fromParam(\"tenantId\"));"} -->

Route enforcement runs in strict order:

1. Missing or invalid session returns **`401 Unauthorized`**.
2. Missing relationship returns **`404 Not Found`** before body or query validation runs, preventing existence leaks.
3. Only authorized requests reach Zod validation and your handler.

## 5. Evolve models with connected `(from, to)` migrations

When a schema change renames or drops a stored role or reparents a child resource, use [`@dads-framework/authorization-migration`](../../../packages/server/authorization-migration/README.md) to classify changes and migrate stored relationships cleanly across PostgreSQL, SQLite, or SpiceDB:

| Helper                                           | Purpose                                                                                                           |
| :----------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| `diffAccessModels(before, after)`                | Classifies additions and computed permission edits as safe, and tuple-bearing removals or narrowings as breaking. |
| `defineAccessMigration(id, { from, to, steps })` | Declares typed `copyRole`, `dropRole`, `copyParent`, and `dropParent` steps preserving wildcards and `expiresAt`. |
| `runPostgresAccessMigrations(options)`           | Applies pending migrations inside per-migration Postgres transactions and records applied IDs idempotently.       |
| `runSqliteAccessMigrations(options)`             | Applies pending migrations inside SQLite transactions and skips already-applied IDs on rerun.                     |
| `runSpiceDbAccessMigrations(options)`            | Replays the same typed step operations against a SpiceDB migration store.                                         |
| `assertAccessMigrationsUpToDate(options)`        | Startup check for Postgres or SQLite that throws an error naming every missing migration ID if the database lags. |

## 6. Migrate from SpiceDB to PostgreSQL (or keep `.zed` in sync)

If you already operate SpiceDB, convert your `.zed` schema directly into typed Dads TypeScript:

```sh
npx @dads-framework/toolbox access import schema.zed --out src/access.ts
```

To migrate a live SpiceDB deployment into PostgreSQL without downtime:

```sh
npx dads-import-spicedb --endpoint localhost:50051 --token dev --database-url "$DATABASE_URL" --out src/access.ts --verify
```

1. **Export schema and tuples:** `dads-import-spicedb` (or `migrateSpiceDbToPostgres` from `@dads-framework/authorization-migration`) reads the live `.zed` schema, fails before touching Postgres if unsupported caveats appear, emits ergonomic Dads TypeScript, ensures the Postgres relationship table exists, and streams all tuples (`subject_relation`, wildcards, and `optional_expires_at`) in idempotent batches.
2. **Verify decision parity:** Passing `--verify` (or calling `verifySpiceDbPostgresParity`) auto-derives positive and negative `check` and `lookupResources` queries and compares SpiceDB against PostgreSQL.
3. **Cut over with zero downtime:** Wrap both backends in `new ShadowAuthorization({ primary: spiceDb, shadow: postgres, mode: "shadow-read", onMismatch, onShadowError })` from `@dads-framework/access/runtime`. It dual-writes relationships and compares reads while keeping SpiceDB authoritative. Once mismatches stay at zero, flip `mode` to `"primary-new"` to make PostgreSQL authoritative, then remove SpiceDB.

To keep a `.zed` file generated from TypeScript instead, call `emitZed(model)` from `@dads-framework/access`. Domain files, route guards, and tests stay unchanged across PostgreSQL, SQLite, and SpiceDB.

## 7. Test grants, denials, and revocations without Docker

Use `@dads-framework/access/testing` (`FakeAuthorization`) for direct-grant unit tests, or pass `new DatabaseSync(":memory:")` to `SqliteAuthorization` to test full parent inheritance, nested folders, and `every(link).perm` in milliseconds. Every protected route should include at least one test verifying that a caller without a relationship receives `404`.

## Related references

- [SDK Glossary & Options](sdk-reference.md) for every DSL helper, combinator, adapter option, migration helper, and CLI command
- [`@dads-framework/access`](../../../packages/access/README.md) for `actor`, `resource`, `compileAccess`, `formatAccessTree`, `createAccessClient`, `ShadowAuthorization`, and `.zed` conversion
- [`@dads-framework/postgres-access`](../../../packages/server/postgres-access/README.md) for plain `pg.Pool` and Drizzle setup, expiring tuples, recursive/polymorphic arrows, `lookupSubjects`, and benchmarks
- [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md) for local, edge, and in-memory SQLite deployments with `BEGIN IMMEDIATE` protected transactions
- [`@dads-framework/authorization-migration`](../../../packages/server/authorization-migration/README.md) for `(from, to)` access migrations and SpiceDB to PostgreSQL cutover
- [ADR 0001: Transactional PostgreSQL ReBAC](../../decisions/0001-transactional-postgres-rebac.md) and [ADR 0006: Permission-Aware Offline Sync](../../decisions/0006-permission-aware-offline-sync.md)
