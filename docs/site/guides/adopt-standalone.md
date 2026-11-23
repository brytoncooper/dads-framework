# Adopt One Package at a Time

You do not need to scaffold a new repository to use Dads. Every framework capability ships as a standalone npm package you can install inside an existing Express, Fastify, Hono, Next.js, or Node.js TypeScript project.

## 1. Add Postgres ReBAC to an existing app (no ORM required)

If you already run PostgreSQL and want Zanzibar-style relationship permissions without operating a second database, an authorization outbox, or an ORM, install `@dads-framework/access` and `@dads-framework/postgres-access` alongside `pg`:

```sh
npm install @dads-framework/access @dads-framework/postgres-access pg zod
```

1. Declare your actors, resources, `children`, and explicit `inherit` rules in TypeScript with `actor`, `resource`, and `compileAccess`.
2. Apply `relationshipSchemaMigration.sql` through your existing migration runner, and optionally pass `columnRelations` (plus `columnRelationIndexSql(bindings)`) to read existing foreign keys like `documents.org_id` or `documents.owner_id` directly with zero dual-writes.
3. Instantiate `PostgresAuthorization` with `executor: preparePostgresChecks(pool)` and call `await authorization.verifyColumnRelations()` at startup. Use `createAccessClient(authorization)` for typed grants/checks, `resolveFilter({ ..., scopeColumns: "auto" })` for 10M-row paginated SQL lists, and `withProtectedPgTransaction({ pool, authorization, retries: 3 }, work)` for serializable writes with automatic `40001` retries.

If your app already uses Drizzle, import `withProtectedDrizzleTransaction` and `transactionExecutor` from `@dads-framework/postgres-access/drizzle`.

See the **[4-file standalone walkthrough in Access & Permissions](permissions.md#option-a-add-dads-access-to-an-existing-app-standalone)** for a complete, copy-pasteable `src/access/` + `src/routes/` layout, [Benchmarks & Proof](benchmarks-and-proof.md) for measured 1-vCPU scaling & SpiceDB numbers, or [Permissions Cookbook & Patterns](permissions-cookbook.md) for advanced recipes.

## 2. Add standalone SQLite ReBAC (Node built-in `node:sqlite`)

For local-first apps, CLI tools, edge workers, or fast in-memory integration tests without Docker, install [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md):

```sh
npm install @dads-framework/access @dads-framework/sqlite-access zod
```

1. Reuse the exact same `compileAccess(...)` model.
2. Wrap Node's built-in `DatabaseSync` with `createNodeSqliteExecutor(db)` and execute `sqliteRelationshipSchemaMigration.sql`.
3. Create `new SqliteAuthorization({ model, namespace, executor })`, wrap it with `createAccessClient`, and guard writes with `withProtectedSqliteTransaction`.

## 3. Migrate between SpiceDB and PostgreSQL (both directions)

If your team already operates SpiceDB and wants to move permission storage into your existing PostgreSQL database without downtime — or starts in PostgreSQL and later wants to move out to SpiceDB — install `@dads-framework/spicedb-access/migration` alongside `@dads-framework/postgres-access`:

```sh
npm install @dads-framework/access @dads-framework/postgres-access @dads-framework/spicedb-access/migration pg zod
```

**SpiceDB → PostgreSQL (zero downtime):**

1. **Import your schema and backfill tuples:** Run `npx dads-import-spicedb --verify` (or call `migrateSpiceDbToPostgres({ spiceDb, postgres: pool, namespace })`). It reads your live SpiceDB `.zed` schema, checks for unsupported caveats before touching Postgres, returns generated Dads TypeScript (`generatedTypeScript`), creates the Postgres relationship table if needed, and streams every tuple (including `subject_relation`, wildcards, and `optional_expires_at`) in idempotent batches.
2. **Verify decision parity:** Call `verifySpiceDbPostgresParity({ spiceDb, postgres, definitions, tuples })` to auto-derive positive and negative `check` and `lookupResources` queries and confirm PostgreSQL matches SpiceDB.
3. **Dual-write and shadow-read in production:** Wrap both backends in `new ShadowAuthorization({ primary: spiceDb, shadow: postgres, mode: "shadow-read", onMismatch, onShadowError })` from `@dads-framework/access/runtime`. Once shadow reads report zero mismatches, switch `mode` to `"primary-new"` so PostgreSQL serves authoritative reads while keeping SpiceDB warm as a fallback, then retire SpiceDB.

**PostgreSQL (including `columnRelations`) → SpiceDB (painless exit ramp):**

1. Apply `columnRelationOutboxTriggerSql(model, bindings).up` so future `INSERT`/`UPDATE`/`DELETE` writes to column-backed tables automatically feed `authorization_outbox` with zero app-code rewrites.
2. Call `migratePostgresToSpiceDb({ model, postgres: pool, spiceDb, namespace, columnRelations: bindings })` to emit/write `.zed` and stream both `dad_authorization_relationship` and every non-`NULL` `columnRelations` row into SpiceDB in idempotent `TOUCH` batches.
3. Verify 0 mismatches with `verifySpiceDbPostgresParity` and cut over.

If you want to keep SpiceDB and only replace hand-written `.zed` files with typed TypeScript, install `@dads-framework/access` alone and convert your schema with the CLI:

```sh
npx @dads-framework/toolbox access import schema.zed --out src/access.ts
```

Author your model in TypeScript, emit `.zed` with `emitZed(model)`, and diff your committed schema file against `emitZed(model)` in CI.

## 4. Add fail-closed HTTP routes and OpenAPI 3.1

Install [`@dads-framework/http`](../../../packages/server/http/README.md) and [`@dads-framework/core/contract`](../../../packages/core/README.md) to declare Fastify routes where every verb requires an explicit `access` rule, rejects unauthorized requests before input validation, and generates OpenAPI 3.1 directly from Zod schemas:

```sh
npm install @dads-framework/http @dads-framework/core/contract zod
```

Read [Routes, Contracts & Clients](routes-and-contracts.md) to wire your first route group.

## 5. Add boundary checks and Doctor to any TypeScript repo

The Dads CLI can inspect an existing repository without rewriting your folder layout:

```sh
npx @dads-framework/toolbox doctor
```

To add an isolated Dads workspace beside an existing codebase, run:

```sh
npm create dads@latest . -- --existing
```

This writes the starter inside a `dads/` subdirectory and leaves your existing files untouched.

## Standalone package catalog

| Capability                                                                                        | Packages                                                                                                                                                     |
| :------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relationship permission model, `createAccessClient`, `ShadowAuthorization`, and `.zed` conversion | [`@dads-framework/access`](../../../packages/access/README.md)                                                                                               |
| Transactional PostgreSQL ReBAC engine (plain `pg.Pool` or Drizzle)                                | [`@dads-framework/postgres-access`](../../../packages/server/postgres-access/README.md)                                                                      |
| Transactional SQLite ReBAC engine (Node built-in `node:sqlite`)                                   | [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md)                                                                          |
| Connected `(from, to)` access migrations and SpiceDB to PostgreSQL cutover                        | [`@dads-framework/spicedb-access/migration`](../../../packages/server/spicedb-access/README.md)                                                              |
| SpiceDB runtime client and outbox                                                                 | [`@dads-framework/spicedb-access`](../../../packages/server/spicedb-access/README.md)                                                                        |
| Typed HTTP routes, guards, and OpenAPI 3.1                                                        | [`@dads-framework/http`](../../../packages/server/http/README.md), [`@dads-framework/core/contract`](../../../packages/core/README.md)                       |
| Auth, sessions, workspaces, SSO, and SCIM                                                         | [`@dads-framework/identity`](../../../packages/server/identity/README.md), [`@dads-framework/identity/tenants`](../../../packages/server/identity/README.md) |
| Audit trail, feature flags, jobs, storage, PDF, CSV                                               | [Browse all packages](https://dadsframework.dev/docs/packages)                                                                                               |
