# Access & Permissions

**The last permissions system you'll ever need.**

Dads lets you write your permission rules once in plain TypeScript and runs them directly inside your existing PostgreSQL or SQLite database — **no extra auth server**, **no stale caches**, **no duplicating foreign keys**, and **mathematically verified** against 27 formal proofs.

- **Fast at any scale:** Sub-millisecond permission checks and instant paginated lists across millions of rows — using your existing tables and indexes.
- **No sync bugs:** Permission checks and database writes run inside the same transaction, so revoking access takes effect immediately.
- **Zero lock-in:** Drop just the access packages into any existing Node app, use them inside the full Dads framework, or migrate to/from SpiceDB later without rewriting your app code.

---

## Option A: Add Dads Access to an existing app (standalone)

Already have an Express, Fastify, Hono, Next.js, or plain Node + Postgres codebase? You do **not** need the rest of the Dads framework. Install the two access packages:

```sh
npm install @dads-framework/access @dads-framework/postgres-access pg
```

Apply `relationshipSchemaMigration.sql` once, then organize permissions into **4 small files**—click any file in the explorer below to see how they import from each other:

<!-- dads:excerpt {"path":"fixtures/standalone-access/src/access/model.ts","displayPath":"src/access/model.ts","note":"1. Define actors, resources, roles & permissions once","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/standalone-access/src/access/postgres.ts","displayPath":"src/access/postgres.ts","note":"2. Wire pg.Pool + columnRelations once at startup","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/standalone-access/src/routes/documents.ts","displayPath":"src/routes/documents.ts","note":"3. Filter SQL lists & guard writes in one transaction","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/standalone-access/src/access/model.test.ts","displayPath":"src/access/model.test.ts","note":"4. Test inheritance, bans & revokes in <1 ms (no Docker)","language":"ts","all":true} -->

> **Rule of thumb:** Bind single-target foreign keys you already have (`documents.org_id`, `documents.owner_id`, `folders.parent_id`) in `columnRelations`. Store dynamic grants (org memberships, teams, wildcards, expiring shares, and bans) via `createAccessClient(authorization).add(...)`.
>
> **Using SQLite instead of Postgres?** Swap `@dads-framework/postgres-access` for [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md) (`SqliteAuthorization` on Node's built-in `node:sqlite`)—same `model.ts`, same `columnRelations` API.

---

## Option B: Inside a full Dads Framework app (opinionated layout)

When you build with the full Dads framework, boundaries are enforced by folder structure so business logic never imports database drivers:

- **`domains/<feature>/access/index.ts`** — Database-free permission model and typed `requires(...)` route guards. Never imports `pg` or `@dads-framework/postgres-access`.
- **`domains/<feature>/server/routes.ts`** — Attaches those guards to every HTTP route; calls an injected repository interface.
- **`assembly/authorization.ts`** — The **only** layer that imports `pg` and `@dads-framework/postgres-access` to wire `columnRelations` and prepared checks.
- **`apps/<surface>/app.ts`** — Composes the assembled services and domain plugins into a runnable API.

Click through the 5 files below to trace how imports flow across boundaries:

<!-- dads:excerpt {"path":"fixtures/dads-app-access/domains/documents/access/index.ts","displayPath":"domains/documents/access/index.ts","note":"Database-free model & HTTP guards (no pg import)","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/dads-app-access/domains/documents/server/routes.ts","displayPath":"domains/documents/server/routes.ts","note":"Routes attach guards & Zod schemas before handlers","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/dads-app-access/domains/documents/server/access.test.ts","displayPath":"domains/documents/server/access.test.ts","note":"Proves policy & route guards in microseconds (no Docker)","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/dads-app-access/assembly/authorization.ts","displayPath":"assembly/authorization.ts","note":"ONLY layer importing pg & postgres-access","language":"ts","all":true} -->

<!-- dads:excerpt {"path":"fixtures/dads-app-access/apps/customer/app.ts","displayPath":"apps/customer/app.ts","note":"Composes assembled services + domain plugins","language":"ts","all":true} -->

Every Dads HTTP route enforces access in strict order:

1. Missing or invalid session → **`401 Unauthorized`**.
2. Missing permission → **`404 Not Found`** before parsing the body or query (zero existence leaks).
3. Only authorized callers reach Zod validation and your handler.

---

## How Dads prevents stale permissions

Because permissions live inside the same database as your app tables, a check and a write happen in one transaction — removing the background sync worker and lag window required by separate auth servers.

![How Dads prevents stale permission bugs](../../../website/site/assets/diagrams/postgres-rebac-transaction.svg)

---

## How Dads compares

Most apps start with custom permission code scattered across API routes, then outgrow it once teams, nested folders, and sharing show up. Usually you have to choose between hard-to-maintain database policies or running a separate permissions server — Dads gives you the simplicity and transactional safety of your database with the full power of a relationship engine:

| What you care about            | Custom code     | Postgres RLS | SpiceDB / OpenFGA | Dads            |
| :----------------------------- | :-------------- | :----------- | :---------------- | :-------------- |
| Revoke access immediately      | Manual          | Yes          | Sync lag          | Yes (same tx)   |
| Teams, folders & sharing       | Gets messy fast | Hard SQL     | Yes               | Yes             |
| No extra service to run        | Yes             | Yes          | No                | Yes             |
| Uses your existing tables      | Yes             | Yes          | No (must copy)    | Yes             |
| Fast paginated lists           | Manual          | Fragile      | Extra network hop | Yes (1 query)   |
| Fast unit tests (no Docker)    | Yes             | No           | No                | Yes             |
| Mathematically verified engine | No              | No           | No                | Yes (27 proofs) |

Want the measured numbers, exact hardware, `EXPLAIN ANALYZE` plans, and formal proofs behind that table? Read **[Benchmarks & Proof](benchmarks-and-proof.md)**.

---

## Go deeper

- **[Benchmarks & Proof](benchmarks-and-proof.md)** — Full technical report: flat 10k → 100,000,000-row scaling on 1 vCPU, 10,000-hop nested groups in 15.8 ms, head-to-head vs SpiceDB (tilted in SpiceDB's favor), SQLite scale, uncertainty/limitations, and 27 Lean 4 proofs.
- **[Permissions Cookbook & Patterns](permissions-cookbook.md)** — Tested recipes for `columnRelations`, protecting `org_id`, nested folders, teams, wildcards, expiring shares, bans, `every()`, and two-way SpiceDB migration.
- **[SDK Glossary & Options](sdk-reference.md)** — Every DSL combinator, adapter option, and CLI command.

## Related references

- [`@dads-framework/access`](../../../packages/access/README.md)
- [`@dads-framework/postgres-access`](../../../packages/server/postgres-access/README.md) & [Full Benchmark Log](../../../packages/server/postgres-access/BENCHMARK.md)
- [`@dads-framework/sqlite-access`](../../../packages/server/sqlite-access/README.md)
- [`@dads-framework/spicedb-access/migration`](../../../packages/server/spicedb-access/README.md)
- [Formal Verification (`formal/access-proofs`)](../../../formal/access-proofs/README.md)
