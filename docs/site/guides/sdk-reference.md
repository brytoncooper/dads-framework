# SDK Glossary & Options

Plain-English definitions of Dads terms, packages, and SDK options for developers and coding agents.

## Core definitions

| Term                                     | Plain-English meaning                                                                                                                                                                                                      |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Actor** (`actor`)                      | Who takes an action, like `user` or `service_account`. Call `user("alice")` for a concrete actor, `user.expiring` for time-limited roles, or `user.anyone` for public wildcards (`user:*`).                                |
| **Resource** (`resource`)                | A protected thing in your app, like `organization`, `task`, or `billing`. Call `task("t1")` to address a concrete record's role slots (`task("t1").assignee`) and permission targets (`task("t1").edit`).                  |
| **Role** (`roles`)                       | A stored link between two things in your database. Example: Alice is a `member` of Organization 1, or Task 9 belongs to `organization` 1.                                                                                  |
| **Permission** (`can`)                   | An action someone is allowed to take, like `view`, `edit`, or `manage`. Computed from roles and parent inheritance. Routes check permissions (`task.can.edit`), never raw roles.                                           |
| **Hierarchy** (`children`, `.child()`)   | Child resources nested under a parent. Every child declares `inherit: "all"`, `inherit: "none"`, or a list such as `inherit: ["manage"]` so sensitive resources stay fail-closed.                                          |
| **Access model** (`compileAccess`)       | Compiles root resources into one `AccessModel`, auto-discovering `children`, `.child()`, `parents`, recursive links, and actors. Pass the compiled model to PostgreSQL, SQLite, or SpiceDB at startup.                     |
| **Access client** (`createAccessClient`) | Symmetric typed runtime wrapper over any `Authorization` backend (`add`, `remove`, `can`, `list`, `whoCan`, `listDirect`). Enforces allowed subject types for every role slot at compile time.                             |
| **Protected transaction**                | Re-checks permission and commits data in the same database transaction (`withProtectedPgTransaction`, `withProtectedDrizzleTransaction`, or `withProtectedSqliteTransaction`). If access is revoked, the write rolls back. |
| **Route access rule** (`access`)         | Who is allowed to call an HTTP endpoint. Every route requires one, and Dads runs it before parsing the request body.                                                                                                       |
| **Domain boundary**                      | Features under `domains/` cannot import each other's files. Put shared handles in `libraries/`; `npx dad check boundaries` enforces this in CI.                                                                            |

## Which package to use

| What you need                                                                      | Package                                                                                         |
| :--------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Define actors, resources, inheritance, `createAccessClient`, and `.zed` conversion | [`@dads-framework/access`](../../../packages/access/README.md)                                  |
| Run permission checks and writes in PostgreSQL (plain `pg.Pool` or Drizzle)        | [`@dads-framework/postgres-access`](../../../packages/server/postgres-access/README.md)         |
| Run permission checks and writes in local SQLite (Node built-in `node:sqlite`)     | [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md)             |
| Run the same permission model against SpiceDB                                      | [`@dads-framework/spicedb-access`](../../../packages/server/spicedb-access/README.md)           |
| Diff models, run `(from, to)` access migrations, and migrate SpiceDB to PostgreSQL | [`@dads-framework/spicedb-access/migration`](../../../packages/server/spicedb-access/README.md) |
| In-memory fakes for unit tests (`FakeAuthorization`)                               | `@dads-framework/access/testing`                                                                |
| Typed HTTP routes that require an access rule and emit OpenAPI 3.1                 | [`@dads-framework/http`](../../../packages/server/http/README.md)                               |
| Shared Zod request/response schemas and route paths (browser + server safe)        | [`@dads-framework/core/contract`](../../../packages/core/README.md)                             |
| Typed fetch client (`getFromApi`, `getPageFromApi`, `sendToApi`)                   | [`@dads-framework/client`](../../../packages/client/README.md)                                  |
| CLI for `dad access`, scaffolding, boundary checks, and Doctor                     | [`@dads-framework/toolbox`](../../../packages/foundation/toolbox/README.md)                     |

## Access modeling (`@dads-framework/access`)

### Building blocks

| Function                      | Options / signature                                                       | What it does                                                                                                                                                                                 |
| :---------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actor(name, options?)`       | `{ id? }`                                                                 | Declares an actor (`user`, `service_account`). Defaults to `z.string().min(1)`. Exposes `user(id)`, `user.expiring`, and `user.anyone`.                                                      |
| `resource(name, spec)`        | `{ roles?, can?, children?, parents?, recursive?, id?, granting? }`       | Declares a resource, its roles, permissions, nested children, multi-parent DAG links (`parents: [org, folder]`), or self-nesting (`recursive: true`).                                        |
| `parent.child(name, spec)`    | `{ inherit, roles?, can?, children?, recursive?, id?, granting? }`        | Splits a child resource into its own variable or file while keeping parent inheritance and auto-discovery in `compileAccess([parent])`.                                                      |
| `compileAccess(nodes, opts?)` | `nodes: DslNode[]`, `{ migrations?, bindings?, allowLookupResourcesOn? }` | Compiles roots into an `AccessModel`, auto-discovering children, parents, lazy thunks, and actors. Use `allowLookupResourcesOn` and `bindings` (`@dads-framework/access/scopes`) on SpiceDB. |
| `compileAccessFromIr(defs)`   | `AccessIrDefinition[]`, `CompileAccessOptions?`                           | Lowers parsed `.zed` IR directly into an `AccessModel`.                                                                                                                                      |
| `formatAccessTree(model)`     | `AccessModel`                                                             | Renders a deterministic ASCII tree of actors, resources, roles, permissions, and `[inherited]` / `[local]` tags.                                                                             |

### Optional subpaths (`@dads-framework/access/catalog` & `/scopes`)

| Subpath                          | Exports                                                                               | Purpose                                                                                                                                 |
| :------------------------------- | :------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------- |
| `@dads-framework/access/catalog` | `grantable`, `lifecycleTrigger`, `catalogOnly`, `checkAccessConformance`              | Customer-assignable role UI metadata (labels, groups, risk level) and lifecycle grant governance checks.                                |
| `@dads-framework/access/scopes`  | `scopeBindings`, `isLookupResourcesAllowed`, `compileScopePlan`, `checkScopeBindings` | Fail-closed SpiceDB `lookupResources` allowlist checks (`allowLookupResourcesOn`) and scoped list planning for external SpiceDB stores. |

### Inheritance (`inherit`)

Every inline child under `children` or separate `.child()` call declares `inherit` explicitly:

| Value             | What it inherits from the parent                                                                |
| :---------------- | :---------------------------------------------------------------------------------------------- |
| `"all"`           | Inherits every permission defined on the parent (merged with any local rules on the same name). |
| `"none"`          | Inherits no parent permissions; only local `can` rules grant access (fail-closed).              |
| `["manage", ...]` | Inherits only the named parent permissions; TypeScript rejects unknown parent permission names. |

### Role holders (who can hold a role)

Pass one holder or an array of holders in `roles: { ... }`:

| Holder                    | `.zed` output          | What it means                                                                                                             |
| :------------------------ | :--------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `user` or `otherResource` | `user` / `other`       | One direct actor or linked resource (pass `() => other` for cyclic references between two resources).                     |
| `team.roles.member`       | `team#member`          | Everyone who holds that role on another resource (such as all members of a team).                                         |
| `user.anyone`             | `user:*`               | Every actor of that type (public links or tenant-wide access).                                                            |
| `user.expiring`           | `user with expiration` | Allows expiring grants via `expiresAt`. Pass `[user, user.expiring]` if SpiceDB needs both permanent and expiring grants. |

### Permission rules & combinators

Inside `can: ({ role, parent, parents }) => ({ ... })`, return a single term, an array (OR), or a combinator expression:

| Expression                             | `.zed` output       | What it means                                                                              |
| :------------------------------------- | :------------------ | :----------------------------------------------------------------------------------------- |
| `[a, b]` or `anyOf(a, b)` or `a.or(b)` | `a + b`             | Grants access if any term matches (OR).                                                    |
| `allOf(a, b)` or `a.and(b)`            | `a & b`             | Requires every term to match (AND).                                                        |
| `expr.unless(blocked)`                 | `expr - blocked`    | Grants `expr` unless the caller also matches `blocked`.                                    |
| `parent.view` / `parents.view`         | `parent->view`      | Traverses a linked parent (or multi-parent `parents`) for its `view` permission.           |
| `every(link).approve`                  | `link.all(approve)` | Must hold `approve` on every linked resource (returns `false` when no resource is linked). |

### Converting between TypeScript and SpiceDB `.zed`

| Function                        | Input         | Output                                                                                          |
| :------------------------------ | :------------ | :---------------------------------------------------------------------------------------------- |
| `emitZed(model)`                | `AccessModel` | SpiceDB `.zed` schema text (adds `use expiration` automatically when needed).                   |
| `parseZed(source)`              | `.zed` string | Parsed schema IR (supports comments, `with expiration`, arrows, `.all()`, `&`, `-`, `#`, `:*`). |
| `emitTypeScript(definitions)`   | Access IR     | Clean TypeScript declarations generated from parsed IR.                                         |
| `emitTypeScriptFromZed(source)` | `.zed` string | Converts an existing `.zed` file straight into typed Dads TypeScript.                           |

## Runtime & database adapters

### Typed client & shadow cutover (`@dads-framework/access/runtime`)

| Export                              | Options & usage                                                                                                                                              |
| :---------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAccessClient(authorization)` | Returns `{ add, remove, can, list, whoCan, listDirect }` with compile-time subject validation on every role slot.                                            |
| `new ShadowAuthorization(options)`  | `{ primary, shadow, mode?: "shadow-read" \| "primary-new", onMismatch?, onShadowError? }`. Dual-writes and compares reads for zero-downtime backend cutover. |

### Low-level `Authorization` port (`@dads-framework/access/runtime`)

PostgreSQL, SQLite, SpiceDB, `ShadowAuthorization`, and test fakes all implement this interface:

| Method                        | Arguments                                                            | What it returns                                                                                      |
| :---------------------------- | :------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| `check(query)`                | `{ subject, permission, resource, consistencyToken?, consistency? }` | `true` or `false` for one permission check.                                                          |
| `checkMany(queries)`          | `PermissionQuery[]`                                                  | Array of booleans for a batch of checks.                                                             |
| `checkEach(queries)`          | `PermissionQuery[]`                                                  | Per-item `{ kind: "answered", allowed }` or `{ kind: "failed", error }` results.                     |
| `lookupResources(query)`      | `{ subject, permission, resourceType }`                              | All resource IDs the user can access.                                                                |
| `lookupSubjects(query)`       | `{ resource, permission, subjectType }`                              | `{ subjects, hasWildcard }` listing everyone who can access a resource (including inherited access). |
| `listDirectSubjects(query)`   | `{ resource, relation }`                                             | Direct role holders only (use for member lists and last-admin checks).                               |
| `relationshipExists(filter)`  | `{ resourceType, resourceId?, relation?, subject? }`                 | `true` if any active link matches.                                                                   |
| `writeRelationships(writes)`  | `RelationshipWrite[]`                                                | Saves or updates links (including `expiresAt`) and returns a consistency token.                      |
| `deleteRelationships(filter)` | `RelationshipFilter`                                                 | Deletes matching links and returns a consistency token.                                              |

### PostgreSQL (`@dads-framework/postgres-access`)

Drizzle is optional. Use the root entry point with plain `pg.Pool`, or import Drizzle helpers from `@dads-framework/postgres-access/drizzle`:

| Export                                            | Entry point                               | Options & usage                                                                                                                                                                                       |
| :------------------------------------------------ | :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new PostgresAuthorization(options)`              | `@dads-framework/postgres-access`         | `{ model, namespace, executor, columnRelations?, queryTimeoutMs?, reuseLookupResultsOn? }`. Accepts a plain `pg.Pool` or `preparePostgresChecks(pool)`.                                               |
| `authorization.verifyColumnRelations()`           | `@dads-framework/postgres-access`         | Checks live PostgreSQL `information_schema.columns` and `pg_indexes` for every `columnRelations` binding; throws if a column is missing. Supports both native `uuid` and `text` columns.              |
| `filterColumnRelationsForModel(model, bindings)`  | `@dads-framework/postgres-access`         | Filters a shared `columnRelations` list down to entities present in one API entrypoint's compiled access model (for customer vs. staff hosts).                                                        |
| `DrizzleTransaction<Db>`                          | `@dads-framework/postgres-access`         | Named structural type for the transaction handle passed to `withProtectedDrizzleTransaction` callbacks.                                                                                               |
| `columnRelationIndexSql(bindings)`                | `@dads-framework/postgres-access`         | Generates `CREATE INDEX IF NOT EXISTS` DDL for `(targetIdColumn, idColumn)` reverse lookups on every column-backed table.                                                                             |
| `authorization.compileFilter(query)`              | `@dads-framework/postgres-access`         | `{ subject, permission, resourceType, idColumn, scopeColumns?: Record<string, string> \| "auto", paramOffset? }`. Compiles a single-query SQL `WHERE` predicate (`{ sql, values }`).                  |
| `authorization.resolveFilter(query)`              | `@dads-framework/postgres-access`         | Executes one tagged reverse-index probe and prunes empty `scopeColumns` branches to minimal `= ANY($N::text[])` predicates (0.39–1.88 ms on 10M rows). Supports `scopeColumns: "auto"`.               |
| `withProtectedPgTransaction(options, work)`       | `@dads-framework/postgres-access`         | `{ pool, authorization, retries?, retryBaseDelayMs? }`. Runs `BEGIN ISOLATION LEVEL SERIALIZABLE` on a plain `pg.Pool`, automatically retrying `40001` conflicts up to `retries` times (default `0`). |
| `withProtectedPostgresTransaction(options, work)` | `@dads-framework/postgres-access`         | Alias for `withProtectedPgTransaction` (`{ pool, authorization }`, zero Drizzle dependency).                                                                                                          |
| `preparePostgresChecks(pool)`                     | `@dads-framework/postgres-access`         | Optional prepared-statement wrapper for point checks on a direct `pg.Pool`.                                                                                                                           |
| `relationshipSchemaMigration`                     | `@dads-framework/postgres-access`         | Base SQL migration creating `dad_authorization_relationship` (with `expires_at` and indexes).                                                                                                         |
| `relationshipExpirationMigration`                 | `@dads-framework/postgres-access`         | Additive v2 SQL migration adding `expires_at` to older v1 tables.                                                                                                                                     |
| `lookupRevisionSchemaMigration`                   | `@dads-framework/postgres-access`         | Optional SQL migration for revision-validated lookup reuse (`reuseLookupResultsOn`).                                                                                                                  |
| `withProtectedDrizzleTransaction(options, work)`  | `@dads-framework/postgres-access/drizzle` | `{ database, authorization }` or `{ transaction, authorization }`. Re-checks permissions and runs Drizzle writes in one serializable transaction.                                                     |
| `transactionExecutor(tx)`                         | `@dads-framework/postgres-access/drizzle` | Adapts a Drizzle transaction handle into a `PostgresAccessExecutor`.                                                                                                                                  |

### SQLite (`@dads-framework/sqlite-access`)

| Export                                          | Options & usage                                                                                                                                                                    |
| :---------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createNodeSqliteExecutor(db)`                  | Wraps Node's built-in `node:sqlite` `DatabaseSync` with zero native addons.                                                                                                        |
| `sqliteRelationshipSchemaMigration`             | SQL migration creating `dad_authorization_relationship` (with `expires_at` built in).                                                                                              |
| `new SqliteAuthorization(options)`              | `{ model, namespace, executor, columnRelations?, now? }`. Full parity with PostgreSQL (`columnRelations`, `expiresAt`, recursive/polymorphic arrows, `every()`, `lookupSubjects`). |
| `authorization.verifyColumnRelations()`         | Verifies live SQLite `PRAGMA table_info` columns and reports leading target index status for every `columnRelations` binding.                                                      |
| `sqliteColumnRelationIndexSql(bindings)`        | Generates `CREATE INDEX IF NOT EXISTS` DDL for `(targetIdColumn, idColumn)` reverse lookups on SQLite column-backed tables.                                                        |
| `authorization.compileFilter(query)`            | `{ subject, permission, resourceType, idColumn, scopeColumns?: Record<string, string> \| "auto", now? }`. Compiles a single-query SQLite `WHERE` filter (`{ sql, values }`).       |
| `withProtectedSqliteTransaction(options, work)` | `{ executor, authorization, now? }`. Runs checks and writes inside `BEGIN IMMEDIATE` with one pinned clock timestamp.                                                              |

### Migrations & SpiceDB cutover (`@dads-framework/spicedb-access/migration`)

| Export                                            | Options & usage                                                                                                                                                               |
| :------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diffAccessModels(before, after)`                 | Returns `{ safe, breaking, permissionChanges, requiresMigration, summary }` classifying every schema change between two compiled models.                                      |
| `defineAccessMigration(id, { from, to, steps })`  | Compiles typed `copyRole`, `dropRole`, `copyParent`, and `dropParent` steps into portable data ops runnable on PostgreSQL, SQLite, or SpiceDB.                                |
| `runPostgresAccessMigrations(options)`            | `{ executor, namespace, migrations, relationshipTable?, migrationsTable? }`. Applies pending migrations in Postgres transactions and skips applied IDs.                       |
| `runSqliteAccessMigrations(options)`              | `{ executor, namespace, migrations, relationshipTable?, migrationsTable? }`. Applies pending migrations in SQLite transactions idempotently.                                  |
| `runSpiceDbAccessMigrations(options)`             | Replays `(from, to)` migration step ops against a SpiceDB migration store.                                                                                                    |
| `assertAccessMigrationsUpToDate(options)`         | `{ dialect: "postgres" \| "sqlite", executor, namespace, migrations }`. Fails startup with missing migration IDs if the database is behind.                                   |
| `migrateSpiceDbToPostgres(options)`               | `{ spiceDb, postgres, namespace, batchSize?, exportPageSize? }`. Reads live `.zed`, emits TypeScript, ensures Postgres DDL, and streams all tuples.                           |
| `migratePostgresToSpiceDb(options)`               | `{ model, postgres, spiceDb, namespace, columnRelations?, batchSize?, pageSize? }`. Writes `.zed` and streams tuple table + `columnRelations` into SpiceDB `TOUCH` writes.    |
| `columnRelationOutboxTriggerSql(model, bindings)` | Generates `{ up, down }` Postgres trigger DDL so future `INSERT`/`UPDATE`/`DELETE` writes on `columnRelations` tables enqueue rows into `authorization_outbox` automatically. |
| `verifySpiceDbPostgresParity(options)`            | `{ spiceDb, postgres, definitions?, tuples?, checkQueries?, lookupQueries? }`. Compares `check` and `lookupResources` parity across both engines.                             |

### Unit & parity testing (`@dads-framework/access/testing`, `sqlite-access/testing`, `postgres-access/testing`)

| Option                                                  | When to use                                                                                                                                    |
| :------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAccessHarness(model)`                            | Zero-`await`, Lean-4-verified pure-TS test harness (`grant`, `revoke`, `advanceTime`, `assertCan`, `assertCannot`, `assertMatrix`, `explain`). |
| `new InMemoryAuthorization(model, { clock? })`          | Full Zanzibar-semantics pure-TS `Authorization` engine for unit tests with deterministic `ControllableClock`.                                  |
| `proveAccess` / `proveWorld` / `defineAccessScenario`   | Write one portable scenario and replay it across in-memory, SQLite, Postgres, or SpiceDB in a single `await`.                                  |
| `createSqliteTestAuthorization(model)`                  | Disposable `:memory:` SQLite database with schema, indexes, and `ControllableClock` (`using env = createSqliteTestAuthorization(model)`).      |
| `proveSqliteFilterParity` / `provePostgresFilterParity` | Proves `compileFilter` and `resolveFilter` (with or without `scopeColumns`) return the exact same rows as `lookupResources` for every subject. |

## HTTP routes & contracts

### Route helpers (`@dads-framework/http`)

Use `getRoute`, `listRoute`, `postRoute`, `postNoContentRoute`, `patchRoute`, `putRoute`, `deleteRoute`, and `routeGroup`:

| Option                                    | Purpose                                                  |
| :---------------------------------------- | :------------------------------------------------------- |
| `path`                                    | Route URL such as `"/tasks/:taskId"`.                    |
| `access`                                  | Required access rule. Omitting it is a TypeScript error. |
| `params` / `query` / `body`               | Zod schemas checked only after `access` passes.          |
| `response` / `item`                       | Zod schema that checks the response before sending it.   |
| `rateLimit` / `timeoutMs` / `siteServing` | Built-in route settings (no hidden middleware).          |

### Route access guards (`@dads-framework/http`)

| Helper                                   | What it enforces                                                                                                                            |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `requires(permission, idSource)`         | Checks `permission` on the target ID (`401` if signed out, `404` if denied).                                                                |
| `requiresScoped(permission, bindings)`   | Lists child rows through parent scopes (useful when pairing with `scopeBindings` on SpiceDB).                                               |
| `requiresVisible(permission)`            | Lists resources visible to the caller via `lookupResources`.                                                                                |
| `requireSession`                         | Caller must be signed in (for routes like `GET /me`).                                                                                       |
| `publicAccess()`                         | Function call declaring an explicitly open endpoint (for login or health checks).                                                           |
| `fromParam(name)`                        | Reads the resource ID from a path param. Also: `fromQuery`, `fromBody`, `fromHeader`, `fromFixed`.                                          |
| `sseRoute` / `createChannelStreamRoutes` | Guarded SSE routes (`stream.close()`, `stream.closed`) and channel streams with `recheckIntervalMs` and automatic disconnect on revocation. |

### Contracts & clients (`@dads-framework/core/contract`, `@dads-framework/client`)

| Export                                      | What it does                                                             |
| :------------------------------------------ | :----------------------------------------------------------------------- |
| `entityIdSchema(brand, description)`        | Creates a branded Zod string ID schema for validation and OpenAPI docs.  |
| `defineRoute(method, template)`             | Declares a reusable route path with `.bind(...)` for clients.            |
| `buildOpenApiDocument(routes, meta)`        | Generates OpenAPI 3.1 directly from your routes and Zod schemas.         |
| `getFromApi`, `getPageFromApi`, `sendToApi` | Fetch helpers that validate request bodies and parse responses with Zod. |

## CLI commands (`@dads-framework/toolbox` & `@dads-framework/spicedb-access/migration`)

| Command                                                      | What it does                                                                  |
| :----------------------------------------------------------- | :---------------------------------------------------------------------------- |
| `dad access tree <file.ts\|file.zed>`                        | Prints the compiled permission inheritance tree using `formatAccessTree`.     |
| `dad access diff <before.ts\|zed> <after.ts\|zed>`           | Compares two access models and flags safe versus breaking tuple changes.      |
| `dad access migrate <slug> --from <before> --to <after>`     | Scaffolds a connected `(from, to)` migration file with typed copy/drop stubs. |
| `dad access import <schema.zed> [--out <path>]`              | Converts a SpiceDB `.zed` schema file into typed Dads TypeScript.             |
| `dads-import-spicedb --endpoint <addr> --database-url <url>` | Streams live schema and tuples from SpiceDB into Postgres with `--verify`.    |
| `dad add resource <name> --api <api>`                        | Scaffolds a new guarded domain and registers it on one API entrypoint.        |
| `dad check boundaries`                                       | Verifies domain import isolation rules in CI.                                 |
| `dad doctor --gate`                                          | Enforces strict type rules, route access coverage, and denial tests.          |

```sh
# Print the resolved access tree for your model (.ts or .zed)
npx dad access tree src/access.ts

# Diff two model revisions before deploying
npx dad access diff src/access.v1.ts src/access.ts

# Scaffold a connected (from, to) access migration
npx dad access migrate rename-member --from src/access.v1.ts --to src/access.ts

# Convert a SpiceDB .zed file into ergonomic Dads TypeScript
npx dad access import schema.zed --out src/access.ts

# Migrate a live SpiceDB database into PostgreSQL and verify 100% parity
npx dads-import-spicedb --endpoint localhost:50051 --token dev --database-url "$DATABASE_URL" --out src/access.ts --verify

# Generate a new domain and wire it into one API
npx dad add resource products --api customer --dry-run

# Check domain import boundaries and Doctor gates
npx dad check boundaries
npx dad doctor --gate
```

## Related guides

- [Access & Permissions](permissions.md)
- [Permissions Cookbook & Patterns](permissions-cookbook.md)
- [Routes, Contracts & Clients](routes-and-contracts.md)
- [Multi-API Composition & CI Gates](boundaries-and-apis.md)
- [Adopt One Package at a Time](adopt-standalone.md)
- [Browse all packages](https://dadsframework.dev/docs/packages)
