# Access & Permissions Benchmarks & Proofs

Measuring PostgreSQL, SQLite, and SpiceDB relationship-based authorization across **10,000 to 100,000,000 rows**, **10,000-hop nested group chains**, and **27 zero-`sorry` Lean 4 theorems** differentially verified against live databases.

> **Back to overview:** [Benchmarks & Proof](benchmarks-and-proof.md) · **Usage guide:** [Access & Permissions](permissions.md)

---

## 1. Formal Correctness Proof (27 Lean 4 Theorems + Differential Oracle)

Speed is worthless if an edge case leaks private data. Dads proves its authorization semantics and SQL compiler model in **27 machine-checked Lean 4 theorems** (zero `sorry`, standard axioms only) in [`formal/access-proofs`](../../../formal/access-proofs/README.md), and differentially tests the TypeScript and SQL implementations against the compiled Lean 4 evaluator.

### 1.1 Formally proved properties

| Safety property                              | Proved in the Lean 4 model                                                                            |
| :------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| **Fail-closed unknown permissions**          | Misspelled or undeclared permissions always evaluate to false.                                        |
| **Revocation monotonicity**                  | Deleting a role, share, or foreign-key link can never escalate access.                                |
| **Exact expiration cutoff**                  | Any grant at or past its expiration timestamp is strictly ignored—zero grace-window leaks.            |
| **Ban dominance**                            | An explicit ban always overrides inherited roles, direct shares, and wildcards.                       |
| **Cycle safety (least fixed point)**         | Cyclic folders or mutually nested groups always terminate and never self-justify access.              |
| **Non-vacuous universal checks**             | Requiring access on every parent fails closed when a resource has zero active parents.                |
| **Strict namespace isolation**               | Relationships in one namespace can never leak into another.                                           |
| **SQL compiler & direct-column equivalence** | Point checks, reverse lookups, SQL filters, branch pruning, and direct-column relations always agree. |

### 1.2 Cross-engine differential verification

A compiled native Lean 4 binary (`dads-access-oracle`) runs in CI and compares live **PostgreSQL**, **SQLite**, and **`InMemoryAuthorization`** against the verified Lean 4 evaluator:

- **1,300 randomized schemas** (nesting, wildcards, nested group usersets, bans, universal checks, expirations, and cyclic graphs)
- **299,200 evaluated queries**
- **0 mismatches** across all three engines (plus live **SpiceDB** parity integration suites covering polymorphic arrows, 4-level recursive folders, `throughAll`, bans, expirations, and `columnRelations` cutover)

---

## 2. Scaling & Throughput Results

### 2.1 The 10k → 100,000,000 row scaling curve on 1 vCPU, 2 GB RAM (Run A)

We grew the documents table by **10,000×**—from **10,000 rows (2.2 MB)** to **100,000,000 rows (22 GB)**—inside the exact same hard-capped **1 vCPU, 2 GB RAM** PostgreSQL 16 container. Single-client latency and 8-worker throughput stay nearly flat across five orders of magnitude:

|       Documents | App table size | Extra auth storage | Point check: Org Member (p50) | Point check: Document Owner (p50) | Point check: Outsider deny (p50) | `LIMIT 50`: Org Member (p50) | `LIMIT 50`: Broad Admin, 10% of table (p50) | Seq scans | 8-worker sustained checks/sec (1 vCPU) |
| --------------: | -------------: | -----------------: | ----------------------------: | --------------------------------: | -------------------------------: | ---------------------------: | ------------------------------------------: | --------: | -------------------------------------: |
|      **10,000** |         2.2 MB |             144 kB |                   **0.44 ms** |                       **0.45 ms** |                      **0.44 ms** |                  **0.44 ms** |                                 **0.36 ms** |     **0** |                **2,657 /s** (0 errors) |
|     **100,000** |          21 MB |             536 kB |                   **0.40 ms** |                       **0.39 ms** |                      **0.40 ms** |                  **0.38 ms** |                                 **0.47 ms** |     **0** |                **2,672 /s** (0 errors) |
|   **1,000,000** |         220 MB |             4.1 MB |                   **0.41 ms** |                       **0.43 ms** |                      **0.40 ms** |                  **0.37 ms** |                                 **1.65 ms** |     **0** |                **2,559 /s** (0 errors) |
|  **10,000,000** |         2.2 GB |              43 MB |                   **0.40 ms** |                       **0.40 ms** |                      **0.39 ms** |                  **0.53 ms** |                                 **2.04 ms** |     **0** |                **2,615 /s** (0 errors) |
| **100,000,000** |      **22 GB** |          **44 MB** |                   **0.50 ms** |                       **0.52 ms** |                      **0.49 ms** |                  **1.19 ms** |                                 **2.19 ms** |     **0** |                **2,505 /s** (0 errors) |

At **100,000,000 rows** on **1 vCPU and 2 GB RAM** (freshly loaded `UNLOGGED` table; see Section 4 #2 for logged-table write throughput):

- **Document Owner `LIMIT 50` list** (20 owned docs out of 100M): **0.57 ms** median (`0.098 ms` PostgreSQL execution time, 100 buffer hits, Index Scan on primary key).
- **Outsider `LIMIT 50` list** (0 visible docs out of 100M): **0.51 ms** median (pruned to `FALSE`—the 22 GB documents table is never touched).
- **Broad Administrator `LIMIT 50` list** (10,000,000 visible docs out of 100M): **2.19 ms** median (`0.644 ms` PostgreSQL execution time, 116 buffer hits, Index Scan + Incremental Sort, **zero sequential scans**).
- **94% sustained throughput retention** (`2,657 → 2,505 checks/sec`) even when the table is **11× larger than total container RAM** (~216M checks/day on one vCPU; under 8-worker saturation on 1 vCPU, p50 is `0.93–1.07 ms` and p99 rises to `65.9–69.0 ms` due to CFS quota throttling).

---

### 2.2 10,000-hop deep nested group chain (1 vCPU, 2 GB RAM)

```text
user:alice → group:g-0 → group:g-1 → group:g-2 → ... → group:g-10000 → document:leaf
```

At every depth (32, 128, 1,024, and 10,000 hops) on our **1 vCPU, 2 GB RAM** PostgreSQL container:

| Nested group depth | Allow check (p50 / p95) | Outsider deny (p50 / p95) | Reverse lookup (p50 / p95) | Mid-chain revoke cuts off access immediately? |
| -----------------: | ----------------------: | ------------------------: | -------------------------: | :-------------------------------------------- |
|        **32 hops** |      **0.31 / 0.37 ms** |        **0.18 / 0.21 ms** |         **0.41 / 0.47 ms** | Yes (link #16 deleted)                        |
|       **128 hops** |      **1.46 / 1.55 ms** |        **0.31 / 0.36 ms** |         **0.45 / 0.51 ms** | Yes (link #64 deleted)                        |
|     **1,024 hops** |      **1.64 / 1.74 ms** |        **0.28 / 0.29 ms** |         **1.50 / 1.65 ms** | Yes (link #512 deleted)                       |
|    **10,000 hops** |    **15.76 / 16.06 ms** |        **0.34 / 0.40 ms** |       **14.34 / 14.50 ms** | Yes (link #5,000 deleted)                     |

Between **1,024 and 10,000 hops**, both allow checks (`1.64 → 15.76 ms`) and reverse lookups (`1.50 → 14.34 ms`) scale linearly (~1.5 µs/hop) while keeping outsider denials under **0.4 ms**.

---

### 2.3 Storage & live-write comparison vs. tuple-only stores (Run B)

Reading existing `org_id` / `owner_id` columns directly dropped extra storage on 10M logged documents from **2.73 GB** to **30 MB** (**91× smaller measured**, projecting to **~600× smaller at 100M rows**) and boosted live mixed read/write throughput:

| Metric (10,000,000 logged documents)                 | Dads on 1 vCPU, 2 GB RAM (direct columns) | Dads on 3 vCPUs, 6 GB RAM (direct columns) | Tuple-only store on 3 vCPUs (10M FKs duplicated) |
| :--------------------------------------------------- | ----------------------------------------: | -----------------------------------------: | -----------------------------------------------: |
| Extra relationship rows required                     |                               **111,027** |                                **111,027** |                                       10,111,000 |
| Extra relationship storage (table + indexes)         |                                 **30 MB** |                                  **30 MB** |                                          2.73 GB |
| Sustained point checks (5 s, 0 errors)               |    **2,479 /s** (8w) · **2,492 /s** (16w) |                 **8,274 /s** (1.75 ms p50) |                                         6,432 /s |
| Mixed reads + live ownership updates (5 s, 0 errors) |      **2,280 ops/s** (340 live updates/s) |       **6,802 ops/s** (835 live updates/s) |                                      4,603 ops/s |

---

### 2.4 Head-to-head: Dads (PostgreSQL) vs. SpiceDB under consistent reads (Run C)

On a 32-vCPU Linux VM comparing zero-staleness consistent reads (SpiceDB `1.57.0` in-memory datastore with `fully_consistent` localhost gRPC vs. Dads on PostgreSQL 16 without `columnRelations`):

| Graph depth | Workers | Engine                |  p50 (ms) | p95 (ms) | p99 (ms) | Throughput (checks/s) | Speedup vs. SpiceDB |
| ----------: | ------: | :-------------------- | --------: | -------: | -------: | --------------------: | ------------------: |
|      2 hops |       1 | **Dads (PostgreSQL)** | **0.275** |    0.702 |    1.192 |             **3,054** |     **2.0× faster** |
|      2 hops |       1 | SpiceDB (in-memory)   |     0.620 |    0.996 |    2.086 |                 1,509 |                  1× |
|      2 hops |       8 | **Dads (PostgreSQL)** | **0.440** |    0.951 |    1.843 |            **14,044** |     **2.5× faster** |
|      2 hops |       8 | SpiceDB (in-memory)   |     1.369 |    2.269 |    3.342 |                 5,678 |                  1× |
|      8 hops |       8 | **Dads (PostgreSQL)** | **0.224** |    0.481 |    0.561 |            **25,178** |     **3.0× faster** |
|      8 hops |       8 | SpiceDB (in-memory)   |     0.814 |    1.654 |    2.116 |                 8,446 |                  1× |
|     16 hops |       8 | **Dads (PostgreSQL)** | **0.381** |    0.491 |    0.544 |            **19,146** |     **3.2× faster** |
|     16 hops |       8 | SpiceDB (in-memory)   |     1.268 |    1.986 |    2.885 |                 5,925 |                  1× |

---

### 2.5 Embedded SQLite scale (Run D)

Measured in-process on Node 24 using built-in SQLite (11 timed trials after warmup):

| Workload                                              | Median (ms) | p95 (ms) | Notes                                             |
| :---------------------------------------------------- | ----------: | -------: | :------------------------------------------------ |
| 100k-row `LIMIT 50` list (500 visible, scoped)        |    **0.04** |     0.05 | 6.8× faster than unscoped filter (0.27 ms)        |
| 100k-row `LIMIT 50` list (20 visible, direct shares)  |    **0.03** |     0.04 | 30 microseconds end-to-end                        |
| 100k-row `LIMIT 50` list (80,000 visible broad admin) |    **3.20** |     6.47 | 13× faster than unscoped filter (42.25 ms)        |
| Depth-100 recursive folder point check                |    **0.11** |     0.13 | Safely walks 100 parent links in 110 microseconds |
| 1,000,000-path diamond DAG point check                |    **0.06** |     0.93 | Deduplication prevents exponential blowup         |
| Batch `checkMany` (100 resources)                     |    **0.22** |     0.27 | ~450,000 decisions/sec                            |
| Batch `checkMany` (1,000 resources)                   |    **1.83** |     2.40 | ~546,000 decisions/sec                            |

---

## 3. Experimental Setup & Capacity

| Run                                   | Environment                                        | Configuration & sampling                                                                                                                                                                                                               |
| :------------------------------------ | :------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run A (10k–100M ladder & 10k-hop)** | Hard-capped **1 vCPU, 2 GB RAM** Docker container  | PostgreSQL 16.16, `UNLOGGED` documents table, 512 MB shared buffers, parallel workers disabled (`0`), prepared checks + auto branch-pruned filters; 40 trials/point check, 25 trials/`LIMIT 50`, `EXPLAIN (ANALYZE, BUFFERS)` verified |
| **Run B (10M logged ablation)**       | **1 vCPU / 2 GB** and **3 vCPU / 6 GB** containers | WAL-logged 10M-row tables comparing 10M duplicated FK tuples (2.73 GB) vs. direct FK columns (30 MB), 5 s sustained read and mixed read/write runs                                                                                     |
| **Run C (PostgreSQL vs. SpiceDB)**    | **32-vCPU Linux VM**                               | PostgreSQL 16.16 vs. SpiceDB 1.57.0 in-memory datastore (`fully_consistent`, localhost gRPC), 5,000-leaf graphs at depths 2, 8, and 16                                                                                                 |
| **Run D (Embedded SQLite)**           | Single-process Node 24 (`node:sqlite`)             | WAL/memory temp store, 100k rows across 200 workspaces, depth-100 folders, 1M-path diamond DAG                                                                                                                                         |

---

## 4. Limitations & Caveats

1. **1-vCPU tail latency under CPU saturation:** Under 8 concurrent workers on 1 vCPU, p50 stayed `0.93–1.07 ms` while p99 rose to `65.9–69.0 ms` due to Linux CFS quota throttling. Keep sustained DB CPU below ~70% or add a second vCPU for single-digit p99.
2. **Unlogged freshly loaded table in Run A:** Run A used `UNLOGGED` to load 100M rows in 2 GB RAM with a clean visibility map; live WAL-logged write throughput is measured in Run B (`2,280 ops/s` on 1 vCPU, `6,802 ops/s` on 3 vCPUs).
3. **Warm index pages vs. cold disk reads:** Cold reads touching uncached blocks incur normal SSD latency (~1–10 ms on NVMe/EBS).
4. **SpiceDB datastore & consistency mode:** `fully_consistent` bypasses SpiceDB's dispatch cache (the apples-to-apples zero-staleness comparison); `minimize_latency` cached reads are faster when bounded staleness is acceptable, while persistent SpiceDB datastores add backing-DB hops absent from its in-memory mode.
5. **Write boundary on `columnRelations`:** Raw SQL updates to direct-column FKs immediately affect permissions. Protect immutable tenant columns (`org_id`) with a `BEFORE UPDATE` trigger and chunk bulk ownership transfers (1,000–5,000 rows/tx).

---

## 5. Reproduce Everything

```sh
# 1. Head-to-head PostgreSQL vs SpiceDB benchmark (requires Docker)
CONTAINER_PER_FILE=1 npm run benchmark -w @dads-framework/postgres-access -- src/point-check-comparison.benchmark.test.ts

# 2. Embedded SQLite 100k-row & deep-tree benchmark (no Docker needed)
VITEST_TIER=benchmark npx vitest run packages/server/sqlite-access/src/sqlite-scale.benchmark.test.ts

# 3. Recursive 10,000-hop group soak test (requires Docker)
CONTAINER_PER_FILE=1 POSTGRES_ACCESS_DEEP_SOAK=1 npm run test:integration -w @dads-framework/postgres-access -- recursive-subject-set.integration.test.ts

# 4. Verify all 27 Lean 4 formal proofs from scratch
(cd formal/access-proofs && lake build)
```

For raw historical runs and planner notes, see [`packages/server/postgres-access/BENCHMARK.md`](../../../packages/server/postgres-access/BENCHMARK.md).
