# Benchmarks & Proof

**Technical Report:** Measuring PostgreSQL, SQLite, and SpiceDB relationship-based authorization across **10,000 to 100,000,000 rows**, **10,000-hop nested group chains**, and **27 machine-checked Lean 4 proofs**.

---

## Abstract

We evaluated whether a single standard application database (PostgreSQL or SQLite) can run full relationship-based permissions—organizations, nested teams, deep folders, direct shares, and explicit bans—all the way up to **100,000,000 rows** on a single vCPU without operating a separate authorization cluster.

- **Flat performance from 10k to 100M rows (1 vCPU, 2 GB RAM):** Across a **10,000× increase in table size** (from 2.2 MB to a 22 GB database—11× larger than total container RAM), median point checks moved by just **0.06 ms** (`0.44 ms → 0.50 ms`), sustained throughput held at **2,505 checks/sec** (~216 million checks/day on one vCPU, 0 errors), and paginated `LIMIT 50` lists stayed at **0.51–2.19 ms** with **zero sequential scans**.
- **10,000 nested groups deep in 15.8 ms (1 vCPU, 2 GB RAM):** Dads traversed a 10,000-hop nested group chain in **15.76 ms** median, denied an outsider in **0.34 ms**, and cut off access immediately when the middle link (#5,000) was deleted. (External graph engines like SpiceDB default to a 50-hop cap and refuse deeper chains.)
- **91× to ~600× less extra storage than tuple-only stores (SpiceDB, OpenFGA, Permify):** External authorization services require duplicating every document's organization and owner foreign keys into a separate relationship store (~2.73 GB at 10M rows, ~27 GB at 100M rows). By reading your existing foreign-key columns directly, Dads stored only **30–44 MB** of dynamic grants, memberships, and bans—even at 100,000,000 documents.
- **2.0× to 3.2× faster than SpiceDB—even with the deck stacked for SpiceDB:** When we gave SpiceDB its in-memory datastore (zero disk I/O), localhost gRPC (zero network hop), zero sync overhead, and disabled Dads' direct-column optimization, Dads on real PostgreSQL 16 still beat SpiceDB by **2.0×–3.2×** in throughput (**14,044–25,178 checks/sec** vs **5,678–8,446 checks/sec**) and **3×–4×** in median latency.
- **Mathematically verified correctness:** **27 zero-`sorry` Lean 4 theorems** and **299,200 differential queries** across 1,300 randomized schemas comparing PostgreSQL, SQLite, SpiceDB, and our in-memory test engine with **0 mismatches**.

---

## 1. Motivation & Hypothesis

Production applications usually hit a wall with permissions:

1. **Custom code in API routes** breaks down once teams, nested folders, indirect inheritance, and filtered paginated lists are required.
2. **External authorization clusters** (SpiceDB, OpenFGA, Permify) handle graphs, but force you to run a second datastore, pay network hops on every request, live with asynchronous revocation lag, and duplicate millions of foreign keys you already store in SQL.
3. **Hand-written SQL / RLS** stays inside one transaction, but complex OR conditions across ownership, direct shares, and organization memberships frequently collapse into sequential table scans on paginated lists.

**Hypothesis:** By (a) reading single-target foreign keys directly from existing application tables, (b) pruning empty permission branches before executing paginated list queries, and (c) executing prepared parameterized SQL checks, a single 1-vCPU PostgreSQL instance can scale flat from 10,000 to 100,000,000 rows while beating dedicated authorization services on speed, storage, and transactional safety.

---

## 2. Experimental Design & Test Schema

Every table, column, permission rule, and test user is defined explicitly here so no label in the results tables is ambiguous.

### 2.1 Database schema and permission rule

The scaling ladder models a multi-tenant document application with two main tables (plus a nested folder table in the depth-100 test):

| Table                 | Purpose                                     | Columns & indexes                                                                                                                                                                                            |
| :-------------------- | :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application documents | 10k up to 100,000,000 documents (22 GB max) | Primary key `id`, owning organization `org_id`, nullable creator `owner_id`, sort timestamp `updated_at`. Indexed on `(id)`, `(org_id, updated_at DESC, id)`, `(updated_at DESC, id)`, and `(owner_id, id)`. |
| Dynamic permissions   | Non-foreign-key grants (144 kB to 44 MB)    | Stores organization memberships, up to 100,000 direct document viewer shares, and up to 10,000 explicit document bans.                                                                                       |

**Permission rule under test:** A user can view a document if they are (1) its direct owner (read directly from `owner_id`), or (2) a direct viewer (from the permissions table), or (3) a member/owner of the document's organization (joining `org_id` with organization membership), **unless** explicitly banned on that document.

### 2.2 Test personas (who each benchmark query represents)

Every latency row in Section 3 maps to one of these clearly defined users:

| Persona                 | Access grant in the dataset                                                                | Visible share of the table                  |
| :---------------------- | :----------------------------------------------------------------------------------------- | :------------------------------------------ |
| **Document Owner**      | Named in `owner_id` on 20 specific documents (no organization membership)                  | 20 documents                                |
| **Direct Viewer**       | Granted 20 direct viewer rows in the permissions table (no organization membership)        | 20 documents                                |
| **Organization Member** | Member of 1 organization (out of up to 10,000 organizations)                               | 1,000 docs (at 10M) / 10,000 docs (at 100M) |
| **Broad Administrator** | Member of 10% of all organizations (1,000 orgs at 10M & 100M), with explicit document bans | 10% of the table (10M docs at 100M!)        |
| **Outsider**            | Zero roles, zero shares, zero owned documents (measures fail-closed denial cost)           | 0 documents                                 |

### 2.3 Environments & measurement protocol

Every timed call goes through the public TypeScript adapter and includes SQL compilation, parameter binding, driver transport, and response decoding.

| Run                                                    | Environment                                                                          | PostgreSQL / Engine configuration                                                                                                                                                | Sampling protocol                                                                                                                                                                                                |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run A — 10k to 100M scaling ladder & 10k-hop chain** | Hard-capped **1 vCPU, 2 GB RAM** Linux container (Docker CPU/memory limits enforced) | PostgreSQL 16.16; 512 MB shared buffers, 1.5 GB effective cache, 8 MB work memory, parallel query workers disabled (`0`), prepared checks + auto branch-pruned filters           | 5 warmups; 40 trials per point check; 25 trials per `LIMIT 50` list ordered by `updated_at DESC, id DESC`; `EXPLAIN (ANALYZE, BUFFERS)` verified per tier; 8-worker sustained concurrency runs (3–5 s, 0 errors) |
| **Run B — Storage & multi-vCPU ablation (10M rows)**   | 3 vCPU, 6 GB RAM Linux container                                                     | Identical 10M-row schema run twice: once duplicating all 10M foreign keys as tuples (matching external tuple-only stores) and once reading existing foreign-key columns directly | Same workload plus 16-worker sustained checks and mixed reads + live `UPDATE owner_id` writes (5 s each)                                                                                                         |
| **Run C — Head-to-head PostgreSQL vs SpiceDB**         | Dedicated multi-vCPU Linux VM                                                        | PostgreSQL 16.16 vs SpiceDB 1.57.0 running its **in-memory datastore** with fully consistent gRPC reads                                                                          | Identical 5,000-leaf graphs at depths 2, 8, and 16; 3 alternating rounds of 1,280 checks per depth & worker count after 30 warmups (75% allow / 25% deny), plus live revoke/re-grant verification                |
| **Run D — Embedded SQLite**                            | Single-process Node 24 (`node:sqlite`)                                               | In-process SQLite with WAL/memory temp store                                                                                                                                     | 100k rows across 200 workspaces, depth-25/50/100 recursive folders, 1M-path diamond DAG, and 100/1,000-item batches (11 trials after warmup)                                                                     |

---

## 3. Results

### 3.1 The 10k → 100,000,000 row scaling curve on 1 vCPU, 2 GB RAM (Run A)

We grew the documents table by **10,000×**—from **10,000 rows (2.2 MB)** to **100,000,000 rows (22 GB)**—inside the exact same hard-capped **1 vCPU, 2 GB RAM** PostgreSQL 16 container. Notice how latency and throughput stay flat across five orders of magnitude:

|       Documents | App table size | Extra auth storage | Point check: Org Member (p50) | Point check: Document Owner (p50) | Point check: Outsider deny (p50) | `LIMIT 50`: Org Member (p50) | `LIMIT 50`: Broad Admin, 10% of table (p50) | Seq scans | 8-worker sustained checks/sec (1 vCPU) |
| --------------: | -------------: | -----------------: | ----------------------------: | --------------------------------: | -------------------------------: | ---------------------------: | ------------------------------------------: | --------: | -------------------------------------: |
|      **10,000** |         2.2 MB |             144 kB |                   **0.44 ms** |                       **0.45 ms** |                      **0.44 ms** |                  **0.44 ms** |                                 **0.36 ms** |     **0** |                **2,657 /s** (0 errors) |
|     **100,000** |          21 MB |             536 kB |                   **0.40 ms** |                       **0.39 ms** |                      **0.40 ms** |                  **0.38 ms** |                                 **0.47 ms** |     **0** |                **2,672 /s** (0 errors) |
|   **1,000,000** |         220 MB |             4.1 MB |                   **0.41 ms** |                       **0.43 ms** |                      **0.40 ms** |                  **0.37 ms** |                                 **1.65 ms** |     **0** |                **2,559 /s** (0 errors) |
|  **10,000,000** |         2.2 GB |              43 MB |                   **0.40 ms** |                       **0.40 ms** |                      **0.39 ms** |                  **0.53 ms** |                                 **2.04 ms** |     **0** |                **2,615 /s** (0 errors) |
| **100,000,000** |      **22 GB** |          **44 MB** |                   **0.50 ms** |                       **0.52 ms** |                      **0.49 ms** |                  **1.19 ms** |                                 **2.19 ms** |     **0** |                **2,505 /s** (0 errors) |

At **100,000,000 rows** on **1 vCPU and 2 GB RAM**:

- **Document Owner `LIMIT 50` list** (20 owned docs out of 100M): **0.57 ms** median (`0.098 ms` PostgreSQL execution time, 100 buffer hits, Index Scan on primary key).
- **Outsider `LIMIT 50` list** (0 visible docs out of 100M): **0.51 ms** median (pruned to `FALSE`—the 22 GB documents table is never touched).
- **Broad Administrator `LIMIT 50` list** (10,000,000 visible docs out of 100M): **2.19 ms** median (`0.644 ms` PostgreSQL execution time, 116 buffer hits, Index Scan + Incremental Sort, **zero sequential scans**).
- **94% sustained throughput retention** (`2,657 → 2,505 checks/sec`) even when the table is **11× larger than total container RAM** (~216 million checks/day on one vCPU).

---

### 3.2 What the 10,000-hop deep group test measures (1 vCPU, 2 GB RAM)

Real B2B apps accumulate nested teams, departments, sub-organizations, and shared groups (`engineering` → `platform` → `payments` → ...). Naive recursive SQL slows down exponentially on deep chains, while external services like SpiceDB enforce a hard default **50-hop recursion limit** and reject deeper chains altogether.

**What we tested:** We built a single unbroken chain of nested group memberships up to **10,000 groups deep**:

```text
user:alice → group:g-0 → group:g-1 → group:g-2 → ... → group:g-10000 → document:leaf
```

At every depth (32, 128, 1,024, and 10,000 hops) on our **1 vCPU, 2 GB RAM** PostgreSQL container, we measured:

1. Checking whether Alice can view the leaf document at the end of the chain.
2. Checking that an outsider is denied quickly without walking the whole graph.
3. Reverse-discovering the leaf document via `lookupResources`.
4. Deleting the **single link in the exact middle** (e.g. `group:g-5000`) and confirming Alice loses access **immediately**.

| Nested group depth | Allow check (p50 / p95) | Outsider deny (p50 / p95) | Reverse lookup (p50 / p95) | Mid-chain revoke cuts off access immediately? |
| -----------------: | ----------------------: | ------------------------: | -------------------------: | :-------------------------------------------- |
|        **32 hops** |      **0.31 / 0.37 ms** |        **0.18 / 0.21 ms** |         **0.41 / 0.47 ms** | Yes (link #16 deleted)                        |
|       **128 hops** |      **1.46 / 1.55 ms** |        **0.31 / 0.36 ms** |         **0.45 / 0.51 ms** | Yes (link #64 deleted)                        |
|     **1,024 hops** |      **1.64 / 1.74 ms** |        **0.28 / 0.29 ms** |         **1.50 / 1.65 ms** | Yes (link #512 deleted)                       |
|    **10,000 hops** |    **15.76 / 16.06 ms** |        **0.34 / 0.40 ms** |       **14.34 / 14.50 ms** | Yes (link #5,000 deleted)                     |

Because Dads drives recursive hops with indexed frontier probes instead of repeated full scans, latency scales cleanly and linearly all the way to **10,000 hops**—200× deeper than SpiceDB's default depth limit—while keeping outsider denials under **0.4 ms**.

---

### 3.3 Storage & live-write comparison vs tuple-only stores (Run B)

External authorization services (SpiceDB, OpenFGA, Permify) cannot read your application's `org_id`, `owner_id`, or `parent_id` columns—every single foreign key must be duplicated into a separate relationship store. On our 10M-row dataset, duplicating those foreign keys required **2.73 GB** of extra storage (and scales linearly to ~27 GB at 100M rows). Reading your existing columns directly dropped extra storage to **30 MB** (**91× smaller at 10M rows**, **~600× smaller at 100M rows**) and boosted throughput across the board:

| Metric (10,000,000 documents)                        | Dads on 1 vCPU, 2 GB RAM (direct columns) | Dads on 3 vCPUs, 6 GB RAM (direct columns) | Tuple-only store on 3 vCPUs (10M FKs duplicated) |
| :--------------------------------------------------- | ----------------------------------------: | -----------------------------------------: | -----------------------------------------------: |
| Extra relationship rows required                     |                               **111,027** |                                **111,027** |                                       10,111,000 |
| Extra relationship storage (table + indexes)         |                                 **30 MB** |                                  **30 MB** |                                          2.73 GB |
| Sustained point checks (5 s, 0 errors)               |           **2,479–2,615 /s** (1.0 ms p50) |                 **8,274 /s** (1.75 ms p50) |                                         6,432 /s |
| Mixed reads + live ownership updates (5 s, 0 errors) |      **2,280 ops/s** (340 live updates/s) |       **6,802 ops/s** (835 live updates/s) |                                      4,603 ops/s |

---

### 3.4 Head-to-head: Dads (PostgreSQL) vs SpiceDB (Run C)

#### How we intentionally tilted this test in SpiceDB's favor

Instead of picking a slow SpiceDB configuration to flatter ourselves, we **stacked every advantage in SpiceDB's favor**:

1. **In-memory SpiceDB vs real PostgreSQL:** We ran SpiceDB on its **in-memory datastore** (zero disk I/O, zero write-ahead log, zero backing PostgreSQL or CockroachDB queries—which production SpiceDB requires). Dads ran against **real PostgreSQL 16**.
2. **Zero network-hop penalty:** Both ran on localhost on the same Linux VM, erasing the extra cross-host gRPC hop a separate SpiceDB cluster adds on every production request.
3. **Zero sync or outbox cost:** We timed pure point checks only—excluding the outbox rows, background relay workers, and gRPC write amplification SpiceDB incurs whenever your app creates or moves records.
4. **No direct-column boost for Dads:** Every graph edge lived in Dads' generic tuple table, without even giving Dads the extra +29% speed advantage of reading foreign keys directly.

Even with all four advantages handed to SpiceDB, **Dads on PostgreSQL beat SpiceDB by 2.0×–3.2× in throughput and 3×–4× in median latency** across every tested depth (medians across three alternating rounds):

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

### 3.5 Embedded SQLite scale (Run D)

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

### 3.6 Practical capacity ("What you can support")

| Deployment tier                    | Hardware baseline                                       | Measured performance                                                                                                             | Practical capacity                                                                         |
| :--------------------------------- | :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **Embedded / single-node SQLite**  | Single process, built-in SQLite file, zero network hops | **0.03–0.04 ms** 100k-row lists; **0.11 ms** depth-100 folders; **1.83 ms** / 1k checks                                          | Desktop apps, local-first tools, edge workers, and single-server apps up to ~1M rows.      |
| **1 vCPU PostgreSQL (baseline)**   | **1 vCPU, 2 GB RAM** (~$15/mo managed DB tier)          | **2,505–2,672 checks/sec** across 10k–100M rows; **0.50 ms** checks; **0.51–2.19 ms** 100M-row lists; **15.8 ms** at 10,000 hops | **~216M checks/day**, up to **100M+ rows**, thousands of concurrent users on one small DB. |
| **Multi-vCPU PostgreSQL**          | 3 vCPU (6 GB) up to dedicated primary + read replicas   | **8,274 checks/sec** (3 vCPU); **14,044–25,178 checks/sec** (8 workers)                                                          | **700M–2B+ checks/day**, high-traffic multi-tenant SaaS.                                   |
| **Global multi-region (optional)** | Dedicated SpiceDB cluster via live migration tools      | Zero app-code rewrites, auto-generated Postgres outbox triggers, 0-mismatch parity proof                                         | Planetary multi-region deployments if you ever outgrow PostgreSQL.                         |

---

## 4. Correctness Proof (Formal Verification & Differential Oracle)

Speed is worthless if an edge case leaks private data. Dads backs its authorization semantics and SQL optimizations with **27 machine-checked Lean 4 theorems** (zero `sorry`, standard axioms only) in [`formal/access-proofs`](../../../formal/access-proofs/README.md).

### 4.1 Formally proved safety guarantees

| Safety guarantee                             | What is mathematically impossible in Dads                                                             |
| :------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| **Fail-closed unknown permissions**          | Misspelled or undeclared permissions can never evaluate to true.                                      |
| **Revocation monotonicity**                  | Deleting a role, share, or foreign-key link can never grant someone new access.                       |
| **Exact expiration cutoff**                  | Any grant at or past its expiration timestamp is strictly ignored—zero grace-window leaks.            |
| **Ban dominance**                            | An explicit ban always overrides inherited roles, direct shares, and wildcards.                       |
| **Cycle safety (least fixed point)**         | Cyclic folders or mutually nested groups always terminate and never self-justify access.              |
| **Non-vacuous universal checks**             | Requiring access on every parent fails closed when a resource has zero active parents.                |
| **Strict namespace isolation**               | Relationships in one namespace can never leak into another.                                           |
| **SQL compiler & direct-column equivalence** | Point checks, reverse lookups, SQL filters, branch pruning, and direct-column relations always agree. |

### 4.2 Cross-engine differential verification

A compiled native Lean 4 binary (`dads-access-oracle`) runs in our test suite and compares live **PostgreSQL**, **SQLite**, **SpiceDB**, and **in-memory** engines against the formally verified specification:

- **1,300 randomized schemas** (nesting, wildcards, nested group usersets, bans, universal checks, expirations, and cyclic graphs)
- **299,200 evaluated queries**
- **0 mismatches** across all four engines

---

## 5. Threats to Validity, Limitations & Uncertainty

No benchmark is universal. Keep these constraints in mind when applying these results to your own workload:

1. **1-vCPU tail latency under CPU saturation:** On the hard-capped 1-vCPU container, median latency stayed 0.93–1.07 ms across 10k–100M rows under 8 concurrent workers, while p99 rose to **65.9–69.0 ms** due to Linux CFS CPU quota throttling (100 ms quota periods when 8 connections saturate a single core). Keep sustained database CPU below ~70% or add a second vCPU if you need single-digit-millisecond p99 under heavy concurrency.
2. **Unlogged seeding table in the 100M scaling ladder:** Run A used an `UNLOGGED` documents table solely to load and index 100,000,000 rows inside 2 GB RAM in ~5 minutes. Read paths (`SELECT`, `Index Scan`, `Index Only Scan`) are identical between logged and unlogged tables; heavy concurrent write workloads on logged tables add standard PostgreSQL WAL flush overhead (measured on a logged table in Run B at 2,280 ops/sec on 1 vCPU and 6,802 ops/sec on 3 vCPUs).
3. **Warm index pages vs cold disk reads:** At 100M rows, the documents table and its indexes totaled **22 GB** (11× larger than container RAM). Repeated benchmark lookups hit warm B-tree index pages (`100–116` shared buffer hits); cold first-time queries touching uncached index blocks incur normal SSD read latency (~1–10 ms on NVMe/EBS).
4. **Containerized host variance:** Runs A and B executed inside resource-capped Linux containers on a shared host rather than bare-metal single-tenant servers; expect roughly ±10–15% run-to-run variance depending on underlying storage and CPU generation.
5. **Cross-run non-divisibility:** Runs A/B and Run C ran on different Linux VM environments. Compare engines _within_ the same run rather than dividing throughput numbers across runs.
6. **Extreme graph fanout:** A separate adversarial test with 5,001 parents at depth 16 triggered the exact fallback and took 281–332 ms. Unbounded wide fanout remains expensive on any relationship engine.
7. **Excluded HTTP overhead:** Timings isolate the authorization query (SQL compilation, database round-trip, result decoding) and exclude HTTP parsing, TLS, session lookup, and unrelated application logic.
8. **Write boundary on direct-column relations:** Because direct-column bindings read your application table columns directly, raw SQL updates to those columns immediately affect permissions (unlike an isolated external store). Protect immutable tenant columns like `org_id` with a PostgreSQL `BEFORE UPDATE` trigger, exclude permission-bearing columns from general `PATCH` schemas, and chunk intentional bulk ownership transfers (1,000–5,000 rows per transaction).

---

## 6. Reproducibility

Every checked-in benchmark and proof suite can be run directly from a repository checkout:

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
