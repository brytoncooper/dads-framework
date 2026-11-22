# Benchmarks & Proof

**Technical Report:** Measuring PostgreSQL, SQLite, and SpiceDB relationship-based authorization (`@dads-framework/access`) across 10,000,000 rows, deep hierarchies, and formal Lean 4 verification.

---

## Abstract

We evaluated whether a single application database (PostgreSQL or SQLite) can run full relationship-based permissions (organizations, teams, nested folders, direct shares, and explicit bans) at 10-million-row scale without operating a separate authorization cluster.

- **1-vCPU PostgreSQL baseline (`--cpus=1 --memory=2g`, 10M rows):** Sustained **2,479–2,492 checks/sec** (~215M checks/day, 0 errors), **2,280 mixed read + live write ops/sec**, **0.44–0.57 ms** median single point checks, and **0.51–2.04 ms** median paginated `LIMIT 50` queries with **zero sequential scans**.
- **Storage reduction (`columnRelations`):** Reading existing application foreign keys directly reduced `dad_authorization_relationship` from **2.73 GB (10.11M rows)** to **30 MB (111k rows)** — a **91× reduction**.
- **Head-to-head vs SpiceDB (32-vCPU Linux VM):** Dads on PostgreSQL 16 achieved **14,044–25,178 checks/sec** (0.22–0.44 ms p50) across 2–16 hops at 8 workers — **2.5× to 3.2× higher throughput** than SpiceDB 1.57.0 running its in-memory datastore.
- **Embedded SQLite (`node:sqlite`, 100k rows):** **0.03–0.04 ms** paginated `LIMIT 50` lists, **0.11 ms** depth-100 recursive folder checks, and **1.83 ms** per 1,000-resource batch check.
- **Formal & differential proof:** **27 zero-`sorry` Lean 4 theorems** (standard axioms only) and **299,200 differential queries** across 1,300 randomized schemas comparing PostgreSQL, SQLite, SpiceDB, and `InMemoryAuthorization` with **0 mismatches**.

---

## 1. Motivation & Hypothesis

Production SaaS applications typically hit a wall with authorization:

1. **Scattered route checks** break down once nested folders, group memberships, indirect inheritance, and paginated list filtering are required.
2. **External authorization clusters** (SpiceDB, OpenFGA) solve graph traversal, but introduce a second datastore to operate, network hops on every request, asynchronous sync lag on revocations, and gigabytes of duplicated foreign-key tuples.
3. **Hand-written SQL / RLS** stays transactional, but complex `OR` branches across ownership, direct shares, and org memberships frequently degrade into sequential table scans on paginated `LIMIT 50` queries.

**Hypothesis:** By (a) reading single-target foreign keys directly from existing application tables (`columnRelations`), (b) pruning empty permission branches before executing paginated list queries (`resolveFilter({ scopeColumns: "auto" })`), and (c) executing prepared parameterized SQL checks (`preparePostgresChecks`), a single modest PostgreSQL instance can match or beat external authorization services on latency and throughput while keeping checks and writes inside one database transaction.

---

## 2. Experimental Design & Test Schema

To avoid ambiguous shorthand in the results below, every table, column, permission rule, and test user is defined explicitly here.

### 2.1 Database schema and permission rule (Run A: 10M-row scale)

Run A models a realistic multi-tenant document app with **three tables**:

| Table                            | Purpose                                                                       | Key columns & indexes                                                                                                                                                                                   |
| :------------------------------- | :---------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scale_docs` (10,000,000 rows)   | Application documents table (2.59 GB total with indexes)                      | `id` (PK), `org_id` (owning organization FK), `owner_id` (nullable direct creator/owner FK), `updated_at`. Indexes: `(id)`, `(org_id, updated_at DESC, id)`, `(updated_at DESC, id)`, `(owner_id, id)`. |
| `scale_folders` (101 rows)       | Nested folder hierarchy forming a 100-level chain (`folder-0` → `folder-100`) | `id` (PK), `org_id` (root organization FK on `folder-0`), `parent_id` (self-referencing parent folder FK). Indexes: `(id)`, `(org_id, id)`, `(parent_id, id)`.                                          |
| `dad_authorization_relationship` | Dynamic permissions table for non-FK relationships (111,027 rows = 30 MB)     | Stores organization memberships (`scale/org#owner`), direct document viewer shares (`scale/doc#viewer`, 100k rows), and explicit document bans (`scale/doc#banned`, 10k rows).                          |

**Permission rule under test:**

- A user can **view a document** (`scale/doc#view`) if they are:
  1. the document's direct **`owner`** (read directly from `scale_docs.owner_id` via `columnRelations`), **OR**
  2. an explicitly granted **`viewer`** (read from `dad_authorization_relationship`), **OR**
  3. an owner/member of the document's **`org`** (joining `scale_docs.org_id` with `scale/org#owner` or `#member` in `dad_authorization_relationship`),
  4. **UNLESS** explicitly **`banned`** on that document in `dad_authorization_relationship`.
- A user can **view a folder** (`scale/folder#view`) if they are a direct `viewer`, can view the folder's `org`, or can view its recursive `parent` folder (walking `scale_folders.parent_id` up to 100 levels).

### 2.2 Test personas (who each benchmark query represents)

Every latency row in Section 3.2 maps to one of these six clearly defined users in the 10,000,000-row dataset:

| Persona                 | Exact access grant in the 10M-row dataset                                                                 | Visible docs (out of 10M) |
| :---------------------- | :-------------------------------------------------------------------------------------------------------- | ------------------------: |
| **Document Owner**      | Named in `scale_docs.owner_id` on 20 specific documents (no organization membership)                      |                        20 |
| **Direct Viewer**       | Granted 20 direct `viewer` rows in `dad_authorization_relationship` (no org membership, no `owner_id`)    |                        20 |
| **Organization Member** | Member of 1 organization (`org-42`), whose documents reference `scale_docs.org_id = 'org-42'`             |                     1,000 |
| **Broad Administrator** | Member of 1,000 organizations (`org-0`..`org-999`), with 5 explicit document bans (`doc-10000`..`50000`)  |            999,995 (~10%) |
| **Deep-Folder Member**  | Member of `org-deep` attached only to root `folder-0`; tested on leaf `folder-100` (100 parent hops away) |        101 nested folders |
| **Outsider**            | Zero roles, zero shares, zero `owner_id` references (verifies fail-closed denial cost)                    |                         0 |

### 2.3 Hardware & measurement protocol

Every timed call uses the public TypeScript adapter and includes SQL compilation, parameter binding, driver transport, and response decoding:

- **Run A1 — 1-vCPU PostgreSQL baseline (10M rows):** Single `postgres:16-alpine` (PostgreSQL 16.16) Docker container strictly capped with `--cpus=1 --memory=2g --memory-swap=2g` (verified via `docker inspect`: `NanoCpus=1000000000`, `Memory=2147483648`). Configured for 1 vCPU / 2 GB (`shared_buffers=512MB`, `effective_cache_size=1536MB`, `work_mem=8MB`, `max_parallel_workers_per_gather=0`). Driven by Node 24.20.0 over local TCP (`pg.Pool`, `preparePostgresChecks`, `resolveFilter({ scopeColumns: "auto" })`). Protocol: 5 warmups, 50 timed trials per point check, 30 timed trials per `LIMIT 50` list (`ORDER BY updated_at DESC, id DESC LIMIT 50`), `EXPLAIN (ANALYZE, BUFFERS)` captured per list shape, plus 5-second sustained multi-worker check and mixed read + live `UPDATE scale_docs SET owner_id = ...` write runs.
- **Run A2 — 3-vCPU scaling & tuples-only ablation (10M rows):** Identical 10M-row fixture executed on an unthrottled 3-vCPU / 5.8 GiB Docker VM on the same host, run twice: once storing all 10M `org` links as tuples in `dad_authorization_relationship` (tuples-only) and once with `columnRelations`.
- **Run B — Head-to-head PostgreSQL vs SpiceDB:** 32-vCPU Linux VM (Intel Core i9-13900KF), Node 24.20.0, PostgreSQL 16.16 vs SpiceDB 1.57.0 running its **in-memory datastore** with fully consistent gRPC reads. Identical 5,000-leaf graphs at depths 2, 8, and 16. Three alternating rounds of 1,280 checks per depth and worker count (1 and 8 workers) after 30 warmups per worker (75% granted, 25% denied), followed by live revocation and re-grant verification.
- **Run C — Embedded SQLite (`@dads-framework/sqlite-access`):** Apple M5 Pro, Node 24 built-in `node:sqlite` (`DatabaseSync`), 100,000 rows across 200 workspaces, depth-25/50/100 recursive folder trees, a 1,000,000-path diamond DAG, and 100/1,000-item `checkMany` batches (11 timed trials after warmup).

---

## 3. Results

### 3.1 Storage & sustained throughput on 10,000,000 rows (Run A1 & Run A2)

| Metric (10,000,000 documents)                        |              **1 vCPU, 2 GB RAM** (`columnRelations`) | **3 vCPUs, 5.8 GB RAM** (`columnRelations`) | **3 vCPUs, tuples-only** (no `columnRelations`) |
| :--------------------------------------------------- | ----------------------------------------------------: | ------------------------------------------: | ----------------------------------------------: |
| `dad_authorization_relationship` rows                |                                           **111,027** |                                 **111,027** |                                      10,111,000 |
| `dad_authorization_relationship` total size          |                                             **30 MB** |                                   **30 MB** |                                         2.73 GB |
| Sustained point checks (5 s, 0 errors)               | **2,479 checks/s** (8w, 1.00 ms p50; **2,492** @ 16w) |       **8,274 checks/s** (16w, 1.75 ms p50) |                            6,432 checks/s (16w) |
| Mixed reads + live `UPDATE owner_id` (5 s, 0 errors) |   **2,280 ops/s** (8w, 1.11 ms p50, 340 live flips/s) |     **6,802 ops/s** (16w, 835 live flips/s) |                               4,603 ops/s (16w) |

### 3.2 Single-operation latency & `EXPLAIN ANALYZE` plans on 1 vCPU, 2 GB RAM (Run A1)

All measurements below ran inside the hard-capped **1 vCPU, 2 GB RAM** PostgreSQL 16.16 container holding 10,000,000 documents:

| Operation & persona                                         | p50 (ms) | p95 (ms) | p99 (ms) | Verified PostgreSQL plan (`EXPLAIN ANALYZE`)                   |
| :---------------------------------------------------------- | -------: | -------: | -------: | :------------------------------------------------------------- |
| Point check: **Document Owner** (`scale_docs.owner_id`)     | **0.48** |     0.60 |     0.63 | Index scan on `scale_docs` PK                                  |
| Point check: **Organization Member** (`scale_docs.org_id`)  | **0.45** |     0.51 |     0.52 | Index scan on `scale_docs` PK + tuple PK                       |
| Point check: **Outsider** (denied)                          | **0.44** |     0.54 |     0.58 | Index scan on `scale_docs` PK                                  |
| Point check: **Deep-Folder Member** (depth-100 `parent_id`) | **0.57** |     0.74 |     0.87 | Recursive PK index walk across 100 folder rows                 |
| `LIMIT 50` list: **Outsider** (0 / 10M docs)                | **0.51** |     0.58 |     0.59 | Branch-pruned `FALSE` (`scale_docs` untouched)                 |
| `LIMIT 50` list: **Organization Member** (1,000 / 10M docs) | **0.59** |     0.62 |     0.63 | `Index Only Scan` (`Heap Fetches: 0`, 0.119 ms PG exec)        |
| `LIMIT 50` list: **Direct Viewer** (20 / 10M docs)          | **0.57** |     0.62 |     0.63 | `Index Scan` on `scale_docs` PK                                |
| `LIMIT 50` list: **Document Owner** (20 / 10M docs)         | **0.58** |     0.87 |     1.04 | `Index Scan` on `scale_docs` PK (0.107 ms PG exec)             |
| `LIMIT 50` list: **Broad Administrator** (1M / 10M docs)    | **2.04** |     2.53 |     2.63 | `Index Scan` + `Incremental Sort` (0.506 ms PG exec, 115 hits) |

Every 10M-row paginated list executed with **zero sequential scans**.

### 3.3 Head-to-head: Dads (PostgreSQL) vs SpiceDB in-memory (Run B)

Medians across three alternating rounds on the same 32-vCPU Linux VM:

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

### 3.4 Embedded SQLite scale (Run C)

Measured in-process on Node 24 (`VITEST_TIER=benchmark`, 11 trials after warmup):

| Workload                                              | Median (ms) | p95 (ms) | Notes                                             |
| :---------------------------------------------------- | ----------: | -------: | :------------------------------------------------ |
| 100k-row `LIMIT 50` list (500 visible, scoped)        |    **0.04** |     0.05 | **6.8× faster** than unscoped filter (0.27 ms)    |
| 100k-row `LIMIT 50` list (20 visible, direct shares)  |    **0.03** |     0.04 | 30 microseconds end-to-end                        |
| 100k-row `LIMIT 50` list (80,000 visible broad admin) |    **3.20** |     6.47 | **13× faster** than unscoped filter (42.25 ms)    |
| Depth-100 recursive folder point check                |    **0.11** |     0.13 | Safely walks 100 parent links in 110 microseconds |
| 1,000,000-path diamond DAG point check                |    **0.06** |     0.93 | Cycle/dedup prevents exponential blowup           |
| Batch `checkMany` (100 resources)                     |    **0.22** |     0.27 | ~450,000 decisions/sec                            |
| Batch `checkMany` (1,000 resources)                   |    **1.83** |     2.40 | ~546,000 decisions/sec                            |

### 3.5 Practical capacity translation ("What you can support")

| Deployment tier                    | Hardware baseline                                            | Measured performance                                                                                        | Practical capacity                                                                   |
| :--------------------------------- | :----------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| **Embedded / single-node SQLite**  | Node 24 built-in `node:sqlite`, single file, 0 network hops  | **0.03–0.04 ms** filtered lists on 100k rows; **0.11 ms** depth-100 folders; **1.83 ms** / 1k checks        | Desktop apps, local-first tools, edge services, single-server SaaS up to ~1M rows.   |
| **1 vCPU PostgreSQL (baseline)**   | **1 vCPU, 2 GB RAM** (`--cpus=1 --memory=2g`, ~\$15/mo tier) | **2,492 checks/sec** (0.45–0.57 ms p50); **2,280 mixed read+write ops/sec**; **0.51–2.04 ms** 10M-row lists | **~215M checks/day**, 10M+ app rows, thousands of concurrent active users on 1 vCPU. |
| **Multi-vCPU PostgreSQL**          | 3 vCPU (6 GB) up to 8–32 vCPU primary + optional replicas    | **8,274 checks/sec** on 3 vCPU; **14,044–25,178 checks/sec** on 8 workers                                   | **700M–2B+ checks/day**, high-traffic multi-tenant SaaS, tens of millions of rows.   |
| **Global multi-region (optional)** | Dedicated SpiceDB cluster via `migratePostgresToSpiceDb`     | Live zero-rewrite cutover with auto-generated Postgres outbox triggers + 0-mismatch parity verification     | Planetary multi-region deployments if you ever outgrow PostgreSQL.                   |

---

## 4. Correctness Proof (Formal Verification & Differential Oracle)

Performance is meaningless if an edge case leaks private data. Dads pairs runtime tests with **27 machine-checked Lean 4 theorems** (zero `sorry`, standard axioms only) in [`formal/access-proofs`](../../../formal/access-proofs/README.md).

### 4.1 Formally proved safety properties

| Safety guarantee                     | What is mathematically impossible in Dads                                                                 |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| **Fail-closed unknown permissions**  | Misspelled or undeclared permissions can never evaluate to `true`.                                        |
| **Revocation monotonicity**          | Deleting a role, share, or foreign-key link can never grant someone new access.                           |
| **Exact expiration cutoff**          | Any grant with `expires_at <= now` is strictly ignored — zero off-by-one grace window.                    |
| **Ban dominance (`.unless()`)**      | An explicit ban always overrides inherited roles, direct shares, and wildcards.                           |
| **Cycle safety (least fixed point)** | Cyclic folders or mutually nested groups always terminate and never self-justify access.                  |
| **Non-vacuous `every()`**            | Requiring access on _every_ parent fails closed (`false`) when a resource has zero active parents.        |
| **Strict namespace isolation**       | Tuples in one namespace can never leak into another.                                                      |
| **SQL compiler & `columnRelations`** | `check()`, `lookupResources()`, `compileFilter()`, `resolveFilter()`, and `columnRelations` always agree. |

### 4.2 Differential oracle verification across all 4 engines

A compiled native Lean 4 binary (`dads-access-oracle`) runs in our test suite and compares live **PostgreSQL**, **SQLite**, **SpiceDB**, and **`InMemoryAuthorization`** against the verified specification:

- **1,300 randomized schemas** (nesting, wildcards, `group#member` usersets, `.unless()` exclusions, `every()`, expirations, and cyclic graphs)
- **299,200 evaluated queries**
- **0 mismatches** across all four engines

---

## 5. Threats to Validity, Limitations & Uncertainty

No benchmark is universal. Account for these constraints when extrapolating our measurements to your production workload:

1. **1-vCPU tail queuing under saturation:** On the hard-capped 1-vCPU container, median latency stayed `1.00–1.80 ms` under 8–16 concurrent workers, while p99 rose to **`68.3–73.3 ms`** due to Linux CFS CPU quota throttling (`100 ms` quota period when 8–16 active connections saturate a single core). Real applications running near 100% CPU utilization on 1 vCPU should expect similar queuing spikes unless they keep sustained CPU headroom below ~70% or add a second vCPU.
2. **Host-level variance (Run A):** Run A1/A2 ran inside Docker containers on a macOS developer host (Apple M5 Pro) alongside unrelated background containers. While Docker strictly enforced `NanoCpus=1000000000` and `Memory=2147483648` on PostgreSQL, host I/O and scheduler noise introduce ±10–15% run-to-run variance.
3. **Warm index cache vs cold SSD reads:** Although `scale_docs` + indexes totaled `2.59 GB` (larger than the container's `512 MB` `shared_buffers` and `2.0 GiB` RAM ceiling), our repeated benchmark queries hit warm index pages (`Buffers: shared hit=13..115`). First-time cold queries that must read uncached index blocks from disk will incur storage latency (~1–10 ms on NVMe/EBS).
4. **Cross-machine runs are not directly divisible:** Run A1/A2 (Apple M5 Pro Docker) and Run B (32-vCPU Intel i9-13900KF Linux VM) ran on different CPU architectures and operating systems. Compare engines _within_ the same run, not across runs.
5. **SpiceDB datastore asymmetry (Run B):** Run B tested SpiceDB using its **in-memory** datastore (zero disk I/O) on the same host, which is faster than a persistent Postgres/CockroachDB-backed SpiceDB cluster and omits cross-host network latency. Conversely, Run B does not measure a globally distributed multi-region SpiceDB deployment.
6. **Extreme graph fanout:** A separate adversarial test with a 5,001-way parent branch at depth 16 triggered the exact fallback and took `281–332 ms`. Unbounded wide fanout remains expensive in any ReBAC engine.
7. **Excluded application overhead:** Timings isolate the authorization engine (SQL compile + DB round-trip + decode). End-to-end HTTP request latency will add TLS, routing, session/JWT verification, and application query work.
8. **Write boundary of `columnRelations`:** Because `columnRelations` reads your application table columns directly, a raw SQL `UPDATE` to `org_id`, `owner_id`, or `parent_id` immediately changes permissions (unlike an isolated external SpiceDB store). Protect immutable tenant columns such as `org_id` with a PostgreSQL `BEFORE UPDATE` immutability trigger, keep permission-bearing columns out of general `PATCH` DTOs, and chunk bulk ownership transfers (e.g., 1,000–5,000 rows per transaction).

---

## 6. Reproducibility

Every checked-in benchmark and proof suite can be executed directly from a checkout:

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

For raw historical measurements, planner notes, and opt-in lookup-reuse benchmarks, see [`packages/server/postgres-access/BENCHMARK.md`](../../../packages/server/postgres-access/BENCHMARK.md).
