# Benchmarks & Proof

Every speed and correctness claim in Dads is backed by two things: **reproducible benchmarks** on real databases and **machine-checked mathematical proofs**. This page shows exactly how we measured, what the numbers are, what workloads you can run on them, and how to reproduce every result yourself.

---

## What you can support

Raw milliseconds only matter when translated into real application capacity. Here is what each tier of Dads supports based on our measured runs:

| Deployment tier                    | Typical hardware                                            | Measured performance                                                                                  | What it supports in practice                                                               |
| :--------------------------------- | :---------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **Embedded / single-node SQLite**  | Node 24 built-in `node:sqlite`, single file, 0 network hops | **0.03–0.04 ms** filtered lists on 100k rows; **0.11 ms** depth-100 folders; **1.83 ms** / 1k checks  | Desktop apps, local-first tools, edge services, and single-server SaaS up to ~1M rows.     |
| **Modest single Postgres server**  | 3–4 vCPU, 6–8 GB RAM (comparable to a \$50–\$80/mo DB)      | **8,274 checks/sec** (0.5 ms p50); **6,802 mixed read+write ops/sec**; **0.39–1.88 ms** 10M-row lists | **~715M checks/day**, 10M+ app rows, and thousands of concurrent active users on one box.  |
| **Dedicated Postgres + replicas**  | 8–32 vCPU Postgres primary (+ optional read replicas)       | **14,044–25,178 checks/sec** (0.18–0.44 ms p50) on 8 workers — **2.5×–3.2× faster than SpiceDB**      | High-traffic multi-tenant B2B/B2C SaaS with tens of millions of rows and deep hierarchies. |
| **Global multi-region (optional)** | Dedicated SpiceDB cluster via `migratePostgresToSpiceDb`    | Live zero-rewrite cutover with auto-generated Postgres outbox triggers + 0-mismatch parity check      | Planetary multi-region deployments if you ever outgrow a single PostgreSQL primary.        |

> **Storage footprint matters just as much as latency:** When you bind existing foreign keys (`org_id`, `owner_id`, `parent_id`) with `columnRelations`, a **10,000,000-document** app only needs **30 MB** in `dad_authorization_relationship` (for dynamic shares, memberships, and bans) instead of **2.73 GB** of duplicated tuples (**91× smaller**).

---

## How we measured

We run isolated, repeatable benchmarks with real database drivers, full SQL compilation, transport, and result verification included in the timed paths:

1. **Run A — 10,000,000-row PostgreSQL scale (`Tuples-only` vs `columnRelations`)**
   - **Environment:** Single Docker `postgres:16` container constrained to **3 vCPUs and 5.8 GiB RAM** on Apple M5 Pro, Node 24, local TCP.
   - **Dataset:** **10,000,000 documents** across **10,000 organizations**, **100,000 direct viewer shares**, **10,000 explicit bans**, a **100-level deep recursive folder chain**, and a **broad admin with access to 1,000 organizations (1,000,000 visible documents = 10% of the table)**.
   - **Workload:** Warmed up before timing; `preparePostgresChecks(pool)` for point checks; `resolveFilter({ ..., scopeColumns: "auto" })` for `ORDER BY updated_at DESC, id DESC LIMIT 50` paginated lists; `EXPLAIN (ANALYZE, BUFFERS)` captured for every list scenario; plus 16-worker 5-second sustained read and mixed read + live `UPDATE owner_id` write stress runs.
2. **Run B — Matched head-to-head: Dads (PostgreSQL) vs SpiceDB**
   - **Environment:** 32-vCPU Linux VM (Intel Core i9-13900KF), Node 24.20.0, PostgreSQL 16.16 vs SpiceDB 1.57.0 running its **in-memory datastore** with fully consistent gRPC reads (giving SpiceDB its fastest possible baseline without disk I/O).
   - **Workload:** Identical 5,000-leaf graphs at arrow depths **2, 8, and 16**. Three alternating rounds of 1,280 checks per depth and worker count (1 and 8 workers) after 30 warmups per worker (75% granted, 25% denied), followed by live revocation and re-grant verification.
3. **Run C — Embedded SQLite scale (`@dads-framework/sqlite-access`)**
   - **Environment:** Apple M5 Pro, Node 24 built-in `node:sqlite` (`DatabaseSync`).
   - **Workload:** 100,000 rows across 200 workspaces (`compileFilter` scoped vs unscoped), depth-25/50/100 recursive folder trees, a **1,000,000-path diamond DAG**, and 100/1,000-item `checkMany` batches (11 timed trials after warmup).

### Honest boundaries

Benchmarks are never magic — here is what these runs do **not** claim:

- Timings exclude HTTP routing, auth token parsing, and application business logic outside the authorization query.
- Extreme fanout edge cases (such as a single resource branching across 5,001 parents at depth 16) trigger the exact fallback and take hundreds of milliseconds on any graph engine.
- Run B compares Dads on PostgreSQL against SpiceDB's in-memory testing datastore on the same host, not a distributed multi-region SpiceDB cluster.

---

## Results

### 1. Head-to-head: Dads (PostgreSQL) vs SpiceDB (in-memory)

Measured over local TCP using each adapter's public Node client (medians across three alternating rounds):

| Graph depth | Workers | Engine                |  p50 (ms) | p95 (ms) | p99 (ms) | Throughput (checks/s) | Speedup vs SpiceDB |
| ----------: | ------: | :-------------------- | --------: | -------: | -------: | --------------------: | -----------------: |
|      2 hops |       1 | **Dads (PostgreSQL)** | **0.275** |    0.702 |    1.192 |             **3,054** |    **2.0× faster** |
|      2 hops |       1 | SpiceDB (in-memory)   |     0.620 |    0.996 |    2.086 |                 1,509 |                 1× |
|      2 hops |       8 | **Dads (PostgreSQL)** | **0.440** |    0.951 |    1.843 |            **14,044** |    **2.5× faster** |
|      2 hops |       8 | SpiceDB (in-memory)   |     1.369 |    2.269 |    3.342 |                 5,678 |                 1× |
|      8 hops |       8 | **Dads (PostgreSQL)** | **0.224** |    0.481 |    0.561 |            **25,178** |    **3.0× faster** |
|      8 hops |       8 | SpiceDB (in-memory)   |     0.814 |    1.654 |    2.116 |                 8,446 |                 1× |
|     16 hops |       8 | **Dads (PostgreSQL)** | **0.381** |    0.491 |    0.544 |            **19,146** |    **3.2× faster** |
|     16 hops |       8 | SpiceDB (in-memory)   |     1.268 |    1.986 |    2.885 |                 5,925 |                 1× |

### 2. 10,000,000-row PostgreSQL scale: Tuples-only vs `columnRelations`

Single **3-vCPU, 5.8 GiB RAM** Docker Postgres 16 container holding 10,000,000 documents:

| Metric                                      | Tuples-only (`dad_authorization_relationship`) | With `columnRelations` (`org_id`, `owner_id`, `parent_id`) |              Delta |
| :------------------------------------------ | ---------------------------------------------: | ---------------------------------------------------------: | -----------------: |
| `dad_authorization_relationship` rows       |                                     10,111,000 |                                                **111,027** | **91× fewer rows** |
| `dad_authorization_relationship` total size |                                        2.73 GB |                                                  **30 MB** |    **91× smaller** |
| 16-worker point checks (5 s sustained)      |                           6,432 RPS (0 errors) |                      **8,274 RPS** (0 errors, 1.75 ms p50) |    **+29% faster** |
| 16-worker mixed reads + live writes (5 s)   |                         4,603 ops/s (0 errors) |      **6,802 ops/s** (0 errors, 835 live `UPDATE` flips/s) |    **+48% faster** |

### 3. Single-operation latency & `EXPLAIN ANALYZE` plans on 10M rows

Every single paginated `LIMIT 50` query on the 10,000,000-row table ran with **zero sequential scans**:

| Operation                                            | p50 (ms) | p95 (ms) | p99 (ms) | Verified PostgreSQL plan (`EXPLAIN ANALYZE`)   |
| :--------------------------------------------------- | -------: | -------: | -------: | :--------------------------------------------- |
| Point check: column-backed `owner_id` (allow)        | **0.57** |     0.67 |     0.68 | Index scan on PK                               |
| Point check: column-backed `org_id` (allow)          | **0.53** |     0.58 |     0.59 | Index scan on PK + tuple PK                    |
| Point check: outsider (deny)                         | **0.50** |     0.58 |     0.58 | Index scan on PK                               |
| Point check: depth-100 recursive `folders.parent_id` | **0.62** |     0.83 |     0.85 | Recursive PK index walk                        |
| `LIMIT 50` list: outsider (0 / 10M docs)             | **0.39** |     0.44 |     0.44 | Branch-pruned `FALSE` (table untouched)        |
| `LIMIT 50` list: `org_member` (1,000 / 10M docs)     | **0.62** |     0.72 |     0.72 | `Index Only Scan` (`Heap Fetches: 0`, 0.12 ms) |
| `LIMIT 50` list: `super_sparse` (20 direct / 10M)    | **0.63** |     0.76 |     0.76 | `Index Scan` on PK                             |
| `LIMIT 50` list: `owner_user` (20 owned / 10M)       | **0.77** |     0.98 |     0.98 | `Index Scan` on PK (0.09 ms)                   |
| `LIMIT 50` list: `broad_admin` (1M / 10M docs)       | **1.88** |     2.09 |     2.09 | `Index Only Scan` (0.53 ms, 115 buffer hits)   |

### 4. Embedded SQLite scale (`node:sqlite`)

Measured in-process on Node 24 (`VITEST_TIER=benchmark`, 11 trials after warmup):

| Workload                                              | Median (ms) | p95 (ms) | Notes                                             |
| :---------------------------------------------------- | ----------: | -------: | :------------------------------------------------ |
| 100k-row `LIMIT 50` list (500 visible, scoped)        |    **0.04** |     0.05 | **6.8× faster** than unscoped filter (0.27 ms)    |
| 100k-row `LIMIT 50` list (20 visible, super sparse)   |    **0.03** |     0.04 | 30 microseconds end-to-end                        |
| 100k-row `LIMIT 50` list (80,000 visible broad admin) |    **3.20** |     6.47 | **13× faster** than unscoped filter (42.25 ms)    |
| Depth-100 recursive folder point check                |    **0.11** |     0.13 | Safely walks 100 parent links in 110 microseconds |
| 1,000,000-path diamond DAG point check                |    **0.06** |     0.93 | Cycle/dedup prevents exponential blowup           |
| Batch `checkMany` (100 resources)                     |    **0.22** |     0.27 | ~450,000 decisions/sec                            |
| Batch `checkMany` (1,000 resources)                   |    **1.83** |     2.40 | ~546,000 decisions/sec                            |

---

## Mathematical & differential proof

Speed means nothing if a subtle compiler bug leaks private data. Dads backs its authorization engine and SQL optimizations with **27 machine-checked Lean 4 theorems** (zero `sorry`, standard axioms only) in [`formal/access-proofs`](../../../formal/access-proofs/README.md).

### What is mathematically proved

| Safety guarantee                     | What it means for your app                                                                                |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| **Fail-closed unknown permissions**  | Misspelled or undeclared permissions always evaluate to `false`.                                          |
| **Revocation monotonicity**          | Deleting a relationship or role can **never** accidentally grant someone access.                          |
| **Exact expiration cutoff**          | Any grant with `expires_at <= now` is strictly ignored — no off-by-one grace leaks.                       |
| **Ban dominance (`.unless()`)**      | An explicit ban overrides inherited roles, direct shares, and wildcards without exception.                |
| **Cycle safety (least fixed point)** | Cyclic folders or mutually nested groups always terminate and never self-justify access.                  |
| **Non-vacuous `every()`**            | Requiring access on _every_ parent fails closed (`false`) when a resource has zero active parents.        |
| **Strict namespace isolation**       | Data in one tenant/namespace can never bleed into another.                                                |
| **SQL compiler & `columnRelations`** | `check()`, `lookupResources()`, `compileFilter()`, `resolveFilter()`, and `columnRelations` always agree. |

### Cross-engine differential verification

A native Lean 4 binary (`dads-access-oracle`) runs in our test suite and compares live **PostgreSQL**, **SQLite**, **SpiceDB**, and **`InMemoryAuthorization`** against the formally verified specification:

- **1,300 randomized schemas** (nesting, wildcards, `group#member` usersets, `.unless()` exclusions, `every()`, expirations, and cyclic graphs)
- **299,200 evaluated queries**
- **0 mismatches** across all four engines

---

## Reproduce every result yourself

Every benchmark and proof suite lives in the repository and can be run directly:

```sh
# 1. Head-to-head PostgreSQL vs SpiceDB benchmark (requires Docker)
CONTAINER_PER_FILE=1 npm run benchmark -w @dads-framework/postgres-access -- src/point-check-comparison.benchmark.test.ts

# 2. Embedded SQLite 100k-row & deep-tree benchmark (no Docker needed)
VITEST_TIER=benchmark npx vitest run packages/server/sqlite-access/src/sqlite-scale.benchmark.test.ts

# 3. Recursive 10,000-hop group soak test (requires Docker)
CONTAINER_PER_FILE=1 POSTGRES_ACCESS_DEEP_SOAK=1 npm run test:integration -w @dads-framework/postgres-access -- recursive-subject-set.integration.test.ts

# 4. Verify all 27 Lean 4 formal proofs from scratch (requires Lean 4 / lake)
cd formal/access-proofs && lake build
```

For raw historical runs, planner notes, and opt-in lookup-reuse measurements, see [`packages/server/postgres-access/BENCHMARK.md`](../../../packages/server/postgres-access/BENCHMARK.md).
