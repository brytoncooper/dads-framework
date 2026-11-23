# Permissions Cookbook & Patterns

Source-backed, tested recipes and production best practices for `@dads-framework/access`, `@dads-framework/postgres-access`, `@dads-framework/sqlite-access`, and `@dads-framework/spicedb-access/migration`.

New here? Start with the [5-Minute Access Quickstart](permissions.md) first.

---

## 1. Zero dual-writes with `columnRelations` (91× smaller storage)

Most SaaS apps already store ownership and hierarchy foreign keys on their own tables: `documents.org_id`, `documents.owner_id`, `folders.parent_id`. Copying 10 million of those rows into a separate relationship table wastes gigabytes of disk and creates a drift bug waiting to happen.

Instead, declare your normal model and bind single-target foreign keys directly with `columnRelations` (`packages/server/postgres-access/src/column-relations.integration.test.ts`):

<!-- dads:excerpt {"path":"packages/server/postgres-access/src/column-relations.integration.test.ts","language":"ts","from":"function buildColumnAccessModel() {","through":"      targetIdColumn: \"owner_id\",\n    },\n  ];\n}"} -->

At startup, verify live columns and index status with `verifyColumnRelations()`, and generate recommended `(targetIdColumn, idColumn)` index DDL with `columnRelationIndexSql(bindings)` (`packages/server/postgres-access/src/column-relations.integration.test.ts`):

<!-- dads:excerpt {"path":"packages/server/postgres-access/src/column-relations.integration.test.ts","language":"ts","from":"    const beforeIndexes = await authz.verifyColumnRelations();","through":"    expect(afterIndexes.every((entry) => entry.hasRecommendedIndex)).toBe(true);"} -->

### Best-practice rule: what goes where?

| Put in `columnRelations` (your app table)                          | Keep in `dad_authorization_relationship` (tuple table)           |
| :----------------------------------------------------------------- | :--------------------------------------------------------------- |
| Single-target parent FKs (`documents.org_id`, `tasks.project_id`)  | Org & team memberships (`org#member`, `team#admin`)              |
| Direct actor FKs (`documents.owner_id`, `tickets.assignee_id`)     | Group usersets (`group#member`), public wildcards (`user:*`)     |
| Recursive self-FKs (`folders.parent_id`) — cycles terminate safely | Expiring grants (`expiresAt`), explicit bans (`.unless(banned)`) |
| Schema-qualified tables (`app.documents`)                          | Polymorphic multi-type links (`parents: [org, folder]`)          |

### Safety guarantees & guardrails

- **Impossible drift:** Calling `writeRelationships` or `deleteRelationships` on a column-backed relation throws immediately (`Relation document#org is column-backed by documents.org_id; update the application table directly`).
- **`NULL` = absent:** Setting `documents.owner_id = NULL` revokes ownership immediately in the same SQL `UPDATE`.
- **Single-row moves & revokes:** Moving a folder with 100k child docs updates **1 row** (`folders.parent_id`), and revoking an org admin deletes **1 row** (`org#admin`) — zero 100k-row fan-out updates.
- **Protecting permission-bearing columns:** Because `columnRelations` reads your table columns directly, exclude `org_id`, `owner_id`, and `parent_id` from general `PATCH` DTOs, put an immutability `BEFORE UPDATE` trigger on tenant columns like `org_id` that should never change after `INSERT`, and chunk intentional bulk transfers (1,000–5,000 rows per transaction).
- **10M-row measured win:** On a live 10,000,000-row PostgreSQL database, enabling `columnRelations` shrank `dad_authorization_relationship` from **2.73 GB → 30 MB (91× smaller)**, sustained **2,492 checks/sec on 1 vCPU** (and **8,274 checks/sec on 3 vCPUs**), and jumped mixed reads + live `UPDATE` permission flips from **4,603 → 6,802 ops/sec (+48%)** with **0 errors**. See [Benchmarks & Proof](benchmarks-and-proof.md).

---

## 2. Fast paginated lists on 10M rows (`resolveFilter` + `scopeColumns: "auto"`)

Never load 1,000,000 authorized IDs into Node just to render page 1 (`LIMIT 50`). Embed a compiled authorization filter directly into your SQL `WHERE` clause (`packages/server/postgres-access/src/column-relations.integration.test.ts`):

<!-- dads:excerpt {"path":"packages/server/postgres-access/src/column-relations.integration.test.ts","language":"ts","from":"    const resolvedFilter = await authz.resolveFilter({","through":"    expect(resolvedRows.rows.map((row) => row.id)).toEqual([\"doc-org\"]);"} -->

### Why `resolveFilter` beats plain `compileFilter` on large tables

When a permission has multiple ways in (for example `anyOf(owner, viewer, org.view).unless(banned)`), an SQL `OR` across two different columns (`doc.id IN (...) OR doc.org_id IN (...)`) often prevents Postgres from doing a single clean index scan.

`resolveFilter` executes one tiny tagged index probe, **prunes every empty branch**, and emits minimal `= ANY($N::text[])` predicates:

- **User with 0 access:** returns `sql: "FALSE"` in **0.39 ms** without scanning `documents`.
- **Org member (1,000 docs out of 10M):** prunes the empty `owner`/`viewer` branches and hits `Index Only Scan` on `(org_id, updated_at DESC, id)` in **0.62 ms** (`Heap Fetches: 0`).
- **Broad admin (1,000,000 docs across 1,000 orgs out of 10M):** finishes in **1.88 ms**.

> **Best practice:** Add a composite index on `(org_id, updated_at DESC, id)` (matching your `ORDER BY` key) alongside `columnRelationIndexSql(bindings)`. Use `paramOffset` when embedding after existing `$1..$k` parameters. On SQLite, use `authz.compileFilter({ ..., scopeColumns: "auto" })`.

---

## 3. Complex graphs: nested folders, teams, wildcards, expiry & `every()`

Dads supports the full Zanzibar permission algebra in plain TypeScript — every combinator works identically across PostgreSQL, SQLite, SpiceDB, and the in-memory test harness (`packages/access/src/testing/access-harness.test.ts`):

<!-- dads:excerpt {"path":"packages/access/src/testing/access-harness.test.ts","language":"ts","from":"function buildTestSchema() {","through":"    model: compileAccess([user, group, workspace, folder, document]),\n  };\n}"} -->

- **Nested cyclic groups:** `roleToken("app/group", "member", user.handle)` allows `group#member` inside `group#member` — cycles terminate safely.
- **Self-nested folders (`recursive: true`):** automatically wires `parent->view` and terminates safely even if cyclic `parent_id` rows exist.
- **Universal intersection (`every(parents).view`):** fails closed (`false`) when a resource has zero active parents, and requires `view` on every active parent otherwise.

---

## 4. Protected writes & automatic `40001` retries

Always re-check permissions inside the same database transaction that performs the write — otherwise a concurrent revoke between your route guard and your `UPDATE` can slip through. Pass `retries` to `withProtectedPgTransaction` to recover automatically from PostgreSQL `40001` serialization conflicts (`packages/server/postgres-access/src/column-relations.integration.test.ts`):

<!-- dads:excerpt {"path":"packages/server/postgres-access/src/column-relations.integration.test.ts","language":"ts","from":"    // Update inside a protected serializable transaction; scoped authz preserves columnRelations.","through":"            resource: { type: \"document\", id: \"doc-null\" },\n          }),\n        ).toBe(true);\n      },\n    );"} -->

- **Keep callbacks idempotent** when `retries > 0` (pure DB reads/writes inside the transaction — do not send emails or charge cards inside the retry loop).
- **Scoped handles expire automatically** as soon as the callback returns or throws, making it impossible to leak a transaction client.
- **SQLite equivalent:** `withProtectedSqliteTransaction({ executor, authorization, now }, work)` runs inside `BEGIN IMMEDIATE` with a single pinned clock snapshot.

---

## 5. Testing pyramid: microseconds in memory → SQLite → Postgres

### Layer 1: Zero-`await` policy unit tests (`@dads-framework/access/testing`)

`createAccessHarness(model)` runs our full, Lean-4-verified `InMemoryAuthorization` engine synchronously — no Docker, no `async`/`await`, deterministic clock (`advanceTime`), cycle safety, and decision explanation trees on failure (`packages/access/src/testing/access-harness.test.ts`):

<!-- dads:excerpt {"path":"packages/access/src/testing/access-harness.test.ts","language":"ts","from":"    const access = createAccessHarness(model);\n    const alice = access.actor(user, \"alice\");\n    const bob = user(\"bob\");","through":"    // Revoking the ban restores Alice's inherited access\n    access.revoke(document.roles.banned, \"doc-1\").from(alice);\n    access.assertCan(alice, document.permissions.view, \"doc-1\");"} -->

### Layer 2: Instant SQL & filter parity tests in SQLite (`@dads-framework/sqlite-access/testing`)

Prove your compiled SQL filters return the exact same rows as `lookupResources` in ~5 ms with zero Docker (`packages/server/sqlite-access/src/testing.test.ts`):

<!-- dads:excerpt {"path":"packages/server/sqlite-access/src/testing.test.ts","language":"ts","from":"    using testEnv = createSqliteTestAuthorization(model);","through":"      subjects: [alice, bob, stranger],\n    });"} -->

### Layer 3: Postgres filter parity (`@dads-framework/postgres-access/testing`)

Call `provePostgresFilterParity({ db: pool, authorization, table: "documents", idColumn: "id", permission: document.permissions.view, scopeColumns: "auto", subjects })` in integration tests to prove `compileFilter`, `resolveFilter`, and `lookupResources` return identical row sets against your real Postgres schema.

---

## 6. Migrations & two-way SpiceDB portability

### Evolving your model safely (`(from, to)` migrations)

Use `diffAccessModels(v1, v2)` (or `npx dad access diff v1.ts v2.ts`) to detect breaking tuple changes, declare portable steps with `defineAccessMigration` (`copyRole`, `dropRole`, `copyParent`, `dropParent`), apply them with `runPostgresAccessMigrations` / `runSqliteAccessMigrations` / `runSpiceDbAccessMigrations`, and fail boot if behind with `assertAccessMigrationsUpToDate`.

### Migrating FROM SpiceDB → PostgreSQL (zero downtime)

```sh
npx dads-import-spicedb \
  --endpoint localhost:50051 \
  --token "$SPICEDB_TOKEN" \
  --database-url "$DATABASE_URL" \
  --namespace acme \
  --out ./src/access.ts \
  --verify
```

1. Streams schema + all tuples (`subject_relation`, wildcards, `expiresAt`) into Postgres and generates typed Dads TypeScript.
2. `--verify` runs `verifySpiceDbPostgresParity` to confirm 0 mismatches.
3. Wrap both in `new ShadowAuthorization({ primary: spiceDb, shadow: postgres, mode: "shadow-read" })`, verify 0 live mismatches, flip to `"primary-new"`, and retire SpiceDB.

### Migrating FROM PostgreSQL (even with `columnRelations`) → SpiceDB

If you ever outgrow a single Postgres cluster and want a dedicated multi-region SpiceDB deployment, you are **not locked in** — even if you used `columnRelations` everywhere (`packages/server/spicedb-access/src/migration/lib/postgres-to-spicedb/postgres-to-spicedb.integration.test.ts`):

<!-- dads:excerpt {"path":"packages/server/spicedb-access/src/migration/lib/postgres-to-spicedb/postgres-to-spicedb.integration.test.ts","language":"ts","from":"    const exportedTuples: SpiceDbExportedTuple[] = [];","through":"    for (const statement of triggers.up) {\n      await pool.query(statement);\n    }"} -->

1. `columnRelationOutboxTriggerSql(model, bindings)` creates Postgres triggers so future `INSERT`/`UPDATE`/`DELETE` writes to column-backed tables automatically feed `authorization_outbox` — **zero app-code rewrites**.
2. `migratePostgresToSpiceDb` emits & writes `.zed`, streams active rows from `dad_authorization_relationship`, and materializes every non-`NULL` `columnRelations` row via keyset pagination into idempotent SpiceDB `TOUCH` writes.
3. `verifySpiceDbPostgresParity` proves **0 decision mismatches** before switching traffic.

---

## 7. Formal verification & proof guarantees

Unlike hand-rolled RBAC or untyped SQL helpers, Dads' authorization semantics and SQL compiler optimizations are **machine-checked in Lean 4** ([`formal/access-proofs`](../../../formal/access-proofs/README.md)):

- **27 zero-`sorry` Lean 4 theorems** (standard axioms only) proving:
  - Fail-closed unknown permissions and non-vacuous `every()` (`throughAll`)
  - Exact expiration cutoff (`expires_at <= now` never grants access)
  - `.unless()` exclusion dominance and revocation monotonicity (deleting tuples can never escalate access)
  - Strict namespace isolation
  - Least-fixed-point stability on cyclic graphs (cycles never self-justify)
  - Forward-vs-reverse equivalence (`check` ⇔ `lookupResources` ⇔ `compileFilter`)
  - Multi-`scopeColumns`, `resolveFilter` branch pruning, per-relation userset shortcut, and **`columnRelations` equivalence**
- **Native Lean 4 differential oracle (`dads-access-oracle`):** Continuously compares live PostgreSQL, SQLite, and `InMemoryAuthorization` against the verified Lean 4 evaluator (**0 mismatches** across 1,300 randomized schemas and 299,200 queries).

See [BENCHMARK.md](../../../packages/server/postgres-access/BENCHMARK.md) for full 10M-row numbers and `EXPLAIN (ANALYZE, BUFFERS)` query plans.
