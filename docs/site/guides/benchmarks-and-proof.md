# Benchmarks & Proof

Every speed and correctness claim in Dads is backed by two things: **reproducible benchmarks** on real databases and **machine-checked mathematical proofs**. To keep sizing honest and concrete, our baseline PostgreSQL benchmark runs inside a hard-capped **1 vCPU, 2 GB RAM** container (`--cpus=1 --memory=2g`) holding **10,000,000 rows**—the smallest managed database tier you can rent.

---

## What you can support

Here is what each tier of Dads supports based on our measured runs:

| Deployment tier                    | Hardware baseline                                            | Measured performance                                                                                          | What it supports in practice                                                             |
| :--------------------------------- | :----------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------- |
| **Embedded / single-node SQLite**  | Node 24 built-in `node:sqlite`, single file, 0 network hops  | **0.03–0.04 ms** filtered lists on 100k rows; **0.11 ms** depth-100 folders; **1.83 ms** / 1k checks          | Desktop apps, local-first tools, edge services, and single-server SaaS up to ~1M rows.   |
| **1 vCPU PostgreSQL (baseline)**   | **1 vCPU, 2 GB RAM** (`--cpus=1 --memory=2g`, ~\$15/mo tier) | **2,492 checks/sec** (0.45–0.57 ms p50); **2,280 mixed read+write ops/sec**; **0.51–2.04 ms** 10M-row lists   | **~215M checks/day**, 10M+ app rows, and thousands of concurrent active users on 1 vCPU. |
| **Multi-vCPU PostgreSQL**          | 3 vCPU (6 GB) up to 8–32 vCPU primary + optional replicas    | **8,274 checks/sec** on 3 vCPU; **14,044–25,178 checks/sec** on 8 workers (**2.5×–3.2× faster than SpiceDB**) | **700M–2B+ checks/day**, high-traffic multi-tenant SaaS, tens of millions of rows.       |
| **Global multi-region (optional)** | Dedicated SpiceDB cluster via `migratePostgresToSpiceDb`     | Live zero-rewrite cutover with auto-generated Postgres outbox triggers + 0-mismatch parity check              | Planetary multi-region deployments if you ever outgrow PostgreSQL.                       |

> **Storage footprint matters just as much as CPU:** When you bind existing foreign keys (`org_id`, `owner_id`, `parent_id`) with `columnRelations`, a **10,000,000-document** app only needs **30 MB** in `dad_authorization_relationship` (for dynamic shares, memberships, and bans) instead of **2.73 GB** of duplicated tuples (**91× smaller**).

---

## How we measured

Every benchmark runs against real database drivers with full SQL compilation, parameter binding, network transport, and result verification included in the timed calls:

1. **Run A — Hard-capped 1 vCPU, 2 GB RAM PostgreSQL 16 (10,000,000 rows)**
   - **Environment:** Single `postgres:16-alpine` (PostgreSQL 16.16) Docker container strictly capped with `--cpus=1 --memory=2g --memory-swap=2g` (`NanoCpus=1000000000`, `Memory=2147483648`), realistic 1-vCPU settings (`shared_buffers=512MB`, `effective_cache_size=1536MB`, `work_mem=8MB`, `max_parallel_workers_per_gather=0`), Node 24.20.0 over local TCP.
   - **Dataset:** **10,000,000 documents** across **10,000 organizations**, **100,000 direct viewer shares**, **10,000 explicit bans**, a **100-level deep recursive folder chain**, and a **broad admin holding 1,000 organizations (1,000,000 visible documents = 10% of the table)**.
   - **Workload:** 5 warmups before timing; 50 iterations per point check via `preparePostgresChecks(pool)`; 30 iterations per paginated `ORDER BY updated_at DESC, id DESC LIMIT 50` query via `resolveFilter({ ..., scopeColumns: "auto" })`; `EXPLAIN (ANALYZE, BUFFERS)` verified on every list shape; plus 5-second sustained multi-worker check and mixed read + live `UPDATE owner_id` write stress runs.
   - **Scaling reference:** Running the exact same 10M-row fixture on 3 vCPUs / 5.8 GiB RAM scaled linearly from **2,492 → 8,274 checks/sec** and **2,280 → 6,802 mixed read+write ops/sec** (0 errors), and confirmed the **2.73 GB → 30 MB (91×)** storage drop vs tuples-only.
2. **Run B — Matched head-to-head: Dads (PostgreSQL) vs SpiceDB**
   - **Environment:** 32-vCPU Linux VM (Intel Core i9-13900KF), Node 24.20.0, PostgreSQL 16.16 vs SpiceDB 1.57.0 running its **in-memory datastore** with fully consistent gRPC reads (giving SpiceDB its fastest possible baseline without disk I/O).
   - **Workload:** Identical 5,000-leaf graphs at arrow depths **2, 8, and 16**. Three alternating rounds of 1,280 checks per depth and worker count (1 and 8 workers) after 30 warmups per worker (75% granted, 25% denied), followed by live revocation and re-grant verification.
3. **Run C — Embedded SQLite scale (`@dads-framework/sqlite-access`)**
   - **Environment:** Apple M5 Pro, Node 24 built-in `node:sqlite` (`DatabaseSync`).
   - **Workload:** 100,000 rows across 200 workspaces (`compileFilter` scoped vs unscoped), depth-25/50/100 recursive folder trees, a **1,000,000-path diamond DAG**, and 100/1,000-item `checkMany` batches (11 timed trials after warmup).

### Honest boundaries

- Timings measure the authorization query end-to-end (SQL compile, driver round-trip, result decode) and exclude HTTP routing, auth token parsing, and unrelated app logic.
- Extreme fanout edge cases (such as a single resource branching across 5,001 parents at depth 16) trigger the exact fallback and take hundreds of milliseconds on any graph engine.
- Run B compares Dads on PostgreSQL against SpiceDB's in-memory testing datastore on the same host, not a distributed multi-region SpiceDB cluster.

---

## Results

### 1. Single-vCPU PostgreSQL baseline on 10,000,000 rows (`--cpus=1 --memory=2g`)

All measurements below ran inside one hard-capped **1 vCPU, 2 GB RAM** PostgreSQL 16.16 container holding **10,000,000 documents** (total `dad_authorization_relationship` size: **30 MB** across 111,027 non-FK rows):

#### Single-operation latency & verified `EXPLAIN ANALYZE` plans

| Operation                                            | p50 (ms) | p95 (ms) | p99 (ms) | Verified PostgreSQL plan (`EXPLAIN ANALYZE`)                   |
| :--------------------------------------------------- | -------: | -------: | -------: | :------------------------------------------------------------- |
| Point check: column-backed `owner_id` (allow)        | **0.48** |     0.60 |     0.63 | Index scan on PK                                               |
| Point check: column-backed `org_id` (allow)          | **0.45** |     0.51 |     0.52 | Index scan on PK + tuple PK                                    |
| Point check: outsider (deny)                         | **0.44** |     0.54 |     0.58 | Index scan on PK                                               |
| Point check: depth-100 recursive `folders.parent_id` | **0.57** |     0.74 |     0.87 | Recursive PK index walk                                        |
| `LIMIT 50` list: outsider (0 / 10M docs)             | **0.51** |     0.58 |     0.59 | Branch-pruned `FALSE` (table untouched)                        |
| `LIMIT 50` list: `org_member` (1,000 / 10M docs)     | **0.59** |     0.62 |     0.63 | `Index Only Scan` (`Heap Fetches: 0`, 0.119 ms PG exec)        |
| `LIMIT 50` list: `super_sparse` (20 direct / 10M)    | **0.57** |     0.62 |     0.63 | `Index Scan` on PK                                             |
| `LIMIT 50` list: `owner_user` (20 owned / 10M)       | **0.58** |     0.87 |     1.04 | `Index Scan` on PK (0.107 ms PG exec)                          |
| `LIMIT 50` list: `broad_admin` (1M / 10M docs)       | **2.04** |     2.53 |     2.63 | `Index Scan` + `Incremental Sort` (0.506 ms PG exec, 115 hits) |

Every single 10M-row list query executed with **zero sequential scans**.

#### Sustained throughput on 1 vCPU vs scaling to 3 vCPUs (10M rows)

| Workload (5 s sustained, 10M documents)               |                       **1 vCPU, 2 GB RAM** (`columnRelations`) | **3 vCPUs, 5.8 GB RAM** (`columnRelations`) | **3 vCPUs, tuples-only** (no `columnRelations`) |
| :---------------------------------------------------- | -------------------------------------------------------------: | ------------------------------------------: | ----------------------------------------------: |
| Auth table size (`dad_authorization_relationship`)    |                                                      **30 MB** |                                   **30 MB** |                                         2.73 GB |
| Sustained point checks (0 errors)                     | **2,479 checks/s** (8w, 1.00 ms p50, 2.84 ms p95; 2,492 @ 16w) |       **8,274 checks/s** (16w, 1.75 ms p50) |                            6,432 checks/s (16w) |
| Mixed reads + live `UPDATE owner_id` flips (0 errors) |            **2,280 ops/s** (8w, 1.11 ms p50, 340 live flips/s) |     **6,802 ops/s** (16w, 835 live flips/s) |                               4,603 ops/s (16w) |

---

### 2. Head-to-head: Dads (PostgreSQL) vs SpiceDB (in-memory)

Measured over local TCP using each adapter's public Node client (medians across three alternating rounds on the same 32-vCPU Linux VM):

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

---

### 3. Embedded SQLite scale (`node:sqlite`)

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
