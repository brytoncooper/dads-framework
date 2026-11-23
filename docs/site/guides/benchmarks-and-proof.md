# Benchmarks & Proof

**Technical Report:** Measuring PostgreSQL, SQLite, and SpiceDB relationship-based authorization across **10,000 to 100,000,000 rows**, **10,000-hop nested group chains**, and **27 machine-checked Lean 4 proofs** of the formal semantics and compiler model.

---

## Abstract

We evaluated whether a single standard application database (PostgreSQL or SQLite) can run full relationship-based permissions—organizations, nested teams, deep folders, direct shares, and explicit bans—all the way up to **100,000,000 rows** on a single vCPU without operating a separate authorization cluster.

- **Flat performance from 10k to 100M rows (1 vCPU, 2 GB RAM):** Across a **10,000× increase in table size** (from 2.2 MB to a 22 GB `UNLOGGED` benchmark table—11× larger than total container RAM), single-client median point checks moved by **0.06 ms** (`0.44 ms → 0.50 ms`), 8-worker sustained throughput held at **2,505 checks/sec** (~216M checks/day on one vCPU, 0 errors; note 8-worker saturation raises p99 to 66–69 ms), and paginated `LIMIT 50` lists stayed at **0.36–2.19 ms** across the ladder (**0.51–2.19 ms** at 100M) with **zero sequential scans**.
- **10,000 nested groups deep in 15.8 ms (1 vCPU, 2 GB RAM):** Dads traversed a 10,000-hop nested group chain in **15.76 ms** median, denied an outsider in **0.34 ms**, and cut off access immediately when the middle link (#5,000) was deleted.
- **91× less extra storage measured at 10M rows (projected ~600× at 100M):** External tuple-only stores (SpiceDB, OpenFGA, Permify) require duplicating every document's organization and owner foreign keys into a separate relationship store (**2.73 GB** measured at 10M rows; linearly projected to **~27 GB** at 100M rows). By reading your existing foreign-key columns directly, Dads stored **30 MB** in the logged 10M ablation (Run B) and **43–44 MB** in the 10M–100M scaling ladder (Run A, which includes 100k direct shares + 10k bans + index headroom).
- **2.0×–3.2× higher throughput and 2.3×–3.6× lower median latency vs SpiceDB under consistent reads:** On a 32-vCPU Linux VM comparing consistent reads (SpiceDB `1.57.0` with its in-memory datastore, `fully_consistent`, localhost gRPC vs Dads on PostgreSQL 16 without direct-column optimization), Dads achieved **14,044–25,178 checks/sec** vs **5,678–8,446 checks/sec** (8 workers) and **2.3×–3.6×** lower median latency. Note that `fully_consistent` bypasses SpiceDB's dispatch cache (the apples-to-apples equivalent to zero-staleness transactional reads) and SpiceDB's in-memory backend is a testing datastore rather than a tuned persistent cluster.
- **Formally proved semantics + differential testing:** Semantics and compiler optimizations are proved in **27 zero-`sorry` Lean 4 theorems**, and our PostgreSQL, SQLite, and in-memory implementations are differentially tested against the compiled Lean 4 evaluator (**0 mismatches** across 1,300 randomized schemas and **299,200 queries**), alongside live SpiceDB parity suites.

---

## 1. Motivation & Hypothesis

Production applications usually hit a wall with permissions:

1. **Custom code in API routes** breaks down once teams, nested folders, indirect inheritance, and filtered paginated lists are required.
2. **External authorization clusters** (SpiceDB, OpenFGA, Permify) handle graphs, but force you to run a second datastore, pay network hops on every request, live with asynchronous revocation lag unless every read pays consistent-read cost, and duplicate millions of foreign keys you already store in SQL.
3. **Hand-written SQL / RLS** stays inside one transaction, but complex OR conditions across ownership, direct shares, and organization memberships frequently collapse into sequential table scans on paginated lists.

**Hypothesis:** By (a) reading single-target foreign keys directly from existing application tables, (b) pruning empty permission branches before executing paginated list queries, and (c) executing prepared parameterized SQL checks, a single 1-vCPU PostgreSQL instance can scale flat from 10,000 to 100,000,000 rows while staying competitive with or beating dedicated authorization services on consistent-read speed, storage, and transactional safety.

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
| **Broad Administrator** | Member of 10% of all organizations (1,000 orgs at 10M & 100M), with explicit document bans | 10% of the table (10M docs at 100M)         |
| **Outsider**            | Zero roles, zero shares, zero owned documents (measures fail-closed denial cost)           | 0 documents                                 |

### 2.3 Environments & measurement protocol

Every timed call goes through the public TypeScript adapter and includes SQL compilation, parameter binding, driver transport, and response decoding.

| Run                                                    | Environment                                                                          | PostgreSQL / Engine configuration                                                                                                                                                                                   | Sampling protocol                                                                                                                                                                                                  |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run A — 10k to 100M scaling ladder & 10k-hop chain** | Hard-capped **1 vCPU, 2 GB RAM** Linux container (Docker CPU/memory limits enforced) | PostgreSQL 16.16 on freshly loaded `UNLOGGED` documents table; 512 MB shared buffers, 1.5 GB effective cache, 8 MB work memory, parallel query workers disabled (`0`), prepared checks + auto branch-pruned filters | 5 warmups; 40 single-client trials per point check; 25 trials per `LIMIT 50` list ordered by `updated_at DESC, id DESC`; `EXPLAIN (ANALYZE, BUFFERS)` verified per tier; 8-worker sustained runs (3–5 s, 0 errors) |
| **Run B — Storage & logged-table ablation (10M rows)** | Two arms: **1 vCPU / 2 GB RAM** container and **3 vCPU / 6 GB RAM** container        | Standard WAL-**logged** 10M-row tables run twice: duplicating all 10M foreign keys as tuples (2.73 GB) vs reading existing foreign-key columns directly (111,027 rows, 30 MB)                                       | 8- and 16-worker sustained checks (5 s) and mixed reads + live `UPDATE owner_id` writes (5 s each, 0 errors)                                                                                                       |
| **Run C — Head-to-head PostgreSQL vs SpiceDB**         | **32-vCPU Linux VM**                                                                 | PostgreSQL 16.16 vs SpiceDB 1.57.0 running its **in-memory datastore** with `fully_consistent` gRPC reads over localhost                                                                                            | Identical 5,000-leaf graphs at depths 2, 8, and 16 (run sequentially); 3 alternating rounds of 1,280 checks per depth & worker count after 30 warmups (75% allow / 25% deny), plus live revoke/re-grant checks     |
| **Run D — Embedded SQLite**                            | Single-process Node 24 (`node:sqlite`)                                               | In-process SQLite with WAL/memory temp store                                                                                                                                                                        | 100k rows across 200 workspaces, depth-25/50/100 recursive folders, 1M-path diamond DAG, and 100/1,000-item batches (11 trials after warmup)                                                                       |

---

## 3. Results

### 3.1 The 10k → 100,000,000 row scaling curve on 1 vCPU, 2 GB RAM (Run A)

We grew the documents table by **10,000×**—from **10,000 rows (2.2 MB)** to **100,000,000 rows (22 GB)**—inside the exact same hard-capped **1 vCPU, 2 GB RAM** PostgreSQL 16 container. Single-client latency and 8-worker throughput stay nearly flat across five orders of magnitude:

|       Documents | App table size | Extra auth storage | Point check: Org Member (p50) | Point check: Document Owner (p50) | Point check: Outsider deny (p50) | `LIMIT 50`: Org Member (p50) | `LIMIT 50`: Broad Admin, 10% of table (p50) | Seq scans | 8-worker sustained checks/sec (1 vCPU) |
| --------------: | -------------: | -----------------: | ----------------------------: | --------------------------------: | -------------------------------: | ---------------------------: | ------------------------------------------: | --------: | -------------------------------------: |
|      **10,000** |         2.2 MB |             144 kB |                   **0.44 ms** |                       **0.45 ms** |                      **0.44 ms** |                  **0.44 ms** |                                 **0.36 ms** |     **0** |                **2,657 /s** (0 errors) |
|     **100,000** |          21 MB |             536 kB |                   **0.40 ms** |                       **0.39 ms** |                      **0.40 ms** |                  **0.38 ms** |                                 **0.47 ms** |     **0** |                **2,672 /s** (0 errors) |
|   **1,000,000** |         220 MB |             4.1 MB |                   **0.41 ms** |                       **0.43 ms** |                      **0.40 ms** |                  **0.37 ms** |                                 **1.65 ms** |     **0** |                **2,559 /s** (0 errors) |
|  **10,000,000** |         2.2 GB |              43 MB |                   **0.40 ms** |                       **0.40 ms** |                      **0.39 ms** |                  **0.53 ms** |                                 **2.04 ms** |     **0** |                **2,615 /s** (0 errors) |
| **100,000,000** |      **22 GB** |          **44 MB** |                   **0.50 ms** |                       **0.52 ms** |                      **0.49 ms** |                  **1.19 ms** |                                 **2.19 ms** |     **0** |                **2,505 /s** (0 errors) |

At **100,000,000 rows** on **1 vCPU and 2 GB RAM** (freshly loaded `UNLOGGED` table with a clean visibility map—real tables under live writes perform additional heap fetches on `Index Only Scan` until `VACUUM` updates the visibility map; see Section 5 #2 for logged-table write throughput):

- **Document Owner `LIMIT 50` list** (20 owned docs out of 100M): **0.57 ms** median (`0.098 ms` PostgreSQL execution time, 100 buffer hits, Index Scan on primary key).
- **Outsider `LIMIT 50` list** (0 visible docs out of 100M): **0.51 ms** median (pruned to `FALSE`—the 22 GB documents table is never touched).
- **Broad Administrator `LIMIT 50` list** (10,000,000 visible docs out of 100M): **2.19 ms** median (`0.644 ms` PostgreSQL execution time, 116 buffer hits, Index Scan + Incremental Sort, **zero sequential scans**).
- **94% sustained throughput retention** (`2,657 → 2,505 checks/sec`) even when the table is **11× larger than total container RAM** (~216M checks/day on one vCPU; under 8-worker saturation on 1 vCPU, p50 is `0.93–1.07 ms` and p99 rises to `65.9–69.0 ms` due to CFS quota throttling).

---

### 3.2 What the 10,000-hop deep group test measures (1 vCPU, 2 GB RAM)

Real B2B apps accumulate nested teams, departments, sub-organizations, and shared groups (`engineering` → `platform` → `payments` → ...). Naive recursive SQL blows up exponentially on **diamond DAGs** (where multiple paths converge—see Run D's 1M-path diamond DAG test in Section 3.5) and can struggle on deep graphs without indexed frontier probes, while external engines like SpiceDB enforce a configurable default 50-hop recursion limit.

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

Between **1,024 and 10,000 hops**, both allow checks (`1.64 → 15.76 ms`) and reverse lookups (`1.50 → 14.34 ms`) scale linearly (~1.5 µs/hop) while keeping outsider denials under **0.4 ms** (the 128-hop allow-check row showed a one-off 1.46 ms spike compared to its 0.45 ms reverse lookup).

---

### 3.3 Storage & live-write comparison vs tuple-only stores (Run B)

External authorization services (SpiceDB, OpenFGA, Permify) cannot read your application's `org_id`, `owner_id`, or `parent_id` columns—every single foreign key must be duplicated into a separate relationship store. On our logged 10M-row dataset (Run B), duplicating those foreign keys required **2.73 GB** of extra storage (which linearly projects to **~27 GB** at 100M rows). Reading your existing columns directly dropped extra storage to **30 MB** (**91× smaller measured at 10M rows**, projecting to **~600× smaller at 100M rows**; Run A's 43–44 MB reflects additional direct-share/ban rows and index headroom in the unlogged scaling ladder) and boosted throughput across the board:

| Metric (10,000,000 logged documents)                 | Dads on 1 vCPU, 2 GB RAM (direct columns) | Dads on 3 vCPUs, 6 GB RAM (direct columns) | Tuple-only store on 3 vCPUs (10M FKs duplicated) |
| :--------------------------------------------------- | ----------------------------------------: | -----------------------------------------: | -----------------------------------------------: |
| Extra relationship rows required                     |                               **111,027** |                                **111,027** |                                       10,111,000 |
| Extra relationship storage (table + indexes)         |                                 **30 MB** |                                  **30 MB** |                                          2.73 GB |
| Sustained point checks (5 s, 0 errors)               |    **2,479 /s** (8w) · **2,492 /s** (16w) |                 **8,274 /s** (1.75 ms p50) |                                         6,432 /s |
| Mixed reads + live ownership updates (5 s, 0 errors) |      **2,280 ops/s** (340 live updates/s) |       **6,802 ops/s** (835 live updates/s) |                                      4,603 ops/s |

_(Compare with Run A's 10M unlogged 8-worker figure of **2,615 checks/sec** on 1 vCPU; the ~5% difference reflects WAL-logged vs unlogged table configuration.)_

---

### 3.4 Head-to-head: Dads (PostgreSQL) vs SpiceDB under consistent reads (Run C)

#### Test configuration & trade-offs

To compare **zero-staleness consistent reads** on a single 32-vCPU Linux VM without inventing cross-host network latency:

1. **In-memory SpiceDB vs PostgreSQL 16:** SpiceDB ran on its built-in **in-memory testing datastore** (zero disk I/O or backing-DB round-trips, though not a tuned production datastore), while Dads ran against **PostgreSQL 16.16**.
2. **Consistent reads (`fully_consistent`):** SpiceDB ran with `fully_consistent` reads to match Dads' zero-staleness transactional consistency. Note that `fully_consistent` bypasses SpiceDB's dispatch cache (SpiceDB's `minimize_latency` cached mode is faster when bounded staleness via zedtokens is acceptable).
3. **Localhost transport & pure checks:** Both ran over localhost, timing pure point checks only (excluding outbox/relay write amplification).
4. **Generic tuple table for Dads:** Every graph edge lived in Dads' generic tuple table, without using `columnRelations`.

Under this configuration, **Dads on PostgreSQL beat SpiceDB by 2.0×–3.2× in throughput and 2.3×–3.6× in median latency** across all tested depths (medians across three alternating rounds):

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

_Note on depth 2 vs depth 8:_ Both PostgreSQL and SpiceDB measured faster at depth 8 (`0.224 ms` / `0.814 ms`) than at depth 2 (`0.440 ms` / `1.369 ms`) during the sequential `[2, 8, 16]` run, likely reflecting runtime/host warmup across rounds; compare the two engines **within** each depth row rather than across depths.

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

| Deployment tier                    | Hardware baseline                                       | Measured performance                                                                                                                                         | Practical capacity                                                                                   |
| :--------------------------------- | :------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **Embedded / single-node SQLite**  | Single process, built-in SQLite file, zero network hops | **0.03–0.04 ms** 100k-row lists; **0.11 ms** depth-100 folders; **1.83 ms** / 1k checks                                                                      | Desktop apps, local-first tools, and single-server apps (benchmarked at 100k rows).                  |
| **1 vCPU PostgreSQL (baseline)**   | **1 vCPU, 2 GB RAM** (~$15/mo managed DB tier)          | **2,479–2,672 checks/sec** across 10k–100M rows; **0.50 ms** single-client checks (**66–69 ms p99** at 8-worker CPU saturation); **0.51–2.19 ms** 100M lists | **~216M checks/day**, up to **100M+ rows**; keep CPU <70% or add a 2nd vCPU for single-digit ms p99. |
| **Multi-vCPU PostgreSQL**          | 3 vCPU (6 GB) up to 32-vCPU primary + read replicas     | **8,274 checks/sec** (3 vCPU); **14,044–25,178 checks/sec** (8 workers on 32 vCPU)                                                                           | **700M–2B+ checks/day**, high-traffic multi-tenant SaaS.                                             |
| **Global multi-region (optional)** | Dedicated SpiceDB cluster via live migration tools      | Zero app-code rewrites, auto-generated Postgres outbox triggers, 0-mismatch parity proof                                                                     | Planetary multi-region deployments if you ever outgrow PostgreSQL.                                   |

---

## 4. Correctness Proof (Formal Semantics & Differential Oracle)

Speed is worthless if an edge case leaks private data. Dads proves its authorization semantics and SQL compiler model in **27 machine-checked Lean 4 theorems** (zero `sorry`, standard axioms only) in [`formal/access-proofs`](../../../formal/access-proofs/README.md), and differentially tests the TypeScript and SQL implementations against the compiled Lean 4 evaluator.

### 4.1 Formally proved properties of the semantics and compiler model

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

### 4.2 Cross-engine differential verification

To bridge the Lean 4 model and our production TypeScript/SQL code, a compiled native Lean 4 binary (`dads-access-oracle`) runs in CI and compares live **PostgreSQL**, **SQLite**, and **`InMemoryAuthorization`** against the verified Lean 4 evaluator:

- **1,300 randomized schemas** (nesting, wildcards, nested group usersets, bans, universal checks, expirations, and cyclic graphs)
- **299,200 evaluated queries**
- **0 mismatches** across all three engines (plus dedicated live **SpiceDB** parity integration suites covering polymorphic arrows, 4-level recursive folders, `throughAll`, bans, expirations, and `columnRelations` cutover)

---

## 5. Threats to Validity, Limitations & Uncertainty

No benchmark is universal. Keep these constraints in mind when applying these results to your own workload:

1. **1-vCPU tail latency under CPU saturation:** On the hard-capped 1-vCPU container, median latency stayed 0.93–1.07 ms across 10k–100M rows under 8 concurrent workers, while p99 rose to **65.9–69.0 ms** due to Linux CFS CPU quota throttling (100 ms quota periods when 8 connections saturate a single core). Keep sustained database CPU below ~70% or add a second vCPU if you need single-digit-millisecond p99 under heavy concurrency.
2. **Unlogged freshly loaded table in Run A:** Run A used an `UNLOGGED` documents table solely to load and index 100,000,000 rows inside 2 GB RAM in ~5 minutes. Because the table was freshly loaded with no concurrent updates, the visibility map was clean (`Heap Fetches: 0` on `Index Only Scan`). Production tables under live writes incur additional heap fetches until `VACUUM` refreshes the visibility map, plus standard WAL flush overhead on writes (measured on a WAL-logged 10M table in Run B at 2,280 ops/sec on 1 vCPU and 6,802 ops/sec on 3 vCPUs).
3. **Warm index pages vs cold disk reads:** At 100M rows, the documents table and its indexes totaled **22 GB** (11× larger than container RAM). Repeated benchmark lookups hit warm B-tree index pages (`100–116` shared buffer hits); cold first-time queries touching uncached index blocks incur normal SSD read latency (~1–10 ms on NVMe/EBS).
4. **SpiceDB consistency & datastore mode in Run C:** Run C compared `fully_consistent` reads on SpiceDB's in-memory datastore against PostgreSQL 16. Production SpiceDB with `minimize_latency` caching trades strict real-time revocation for faster cached hits; conversely, a persistent SpiceDB datastore adds database round-trips absent from the in-memory backend.
5. **Containerized host variance:** Runs A and B executed inside resource-capped Linux containers on a shared host rather than bare-metal single-tenant servers; expect roughly ±10–15% run-to-run variance depending on underlying storage and CPU generation.
6. **Cross-run non-divisibility:** Runs A/B and Run C ran on different Linux environments. Compare engines _within_ the same run rather than dividing throughput numbers across runs.
7. **Extreme graph fanout:** A separate adversarial test with 5,001 parents at depth 16 triggered the exact fallback and took 281–332 ms. Unbounded wide fanout remains expensive on any relationship engine.
8. **Excluded HTTP overhead:** Timings isolate the authorization query (SQL compilation, database round-trip, result decoding) and exclude HTTP parsing, TLS, session lookup, and unrelated application logic.
9. **Write boundary on direct-column relations:** Because direct-column bindings read your application table columns directly, raw SQL updates to those columns immediately affect permissions (unlike an isolated external store). Protect immutable tenant columns like `org_id` with a PostgreSQL `BEFORE UPDATE` trigger, exclude permission-bearing columns from general `PATCH` schemas, and chunk intentional bulk ownership transfers (1,000–5,000 rows per transaction).

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

---

## 7. Selective Testing (`dad-test`) Benchmarks & Formal Proof

`@dads-framework/testing` (`dad-test`) proves its selection and caching rules with **36 zero-`sorry` Lean 4 theorems** (`proofs/dad-test/`) and **3 Quint/TLA+ state-machine specs** (`specs/dad-test/`, verified with Apalache Z3 and replayed directly against the compiled Rust binary).

### 7.1 Formal verification layers

| Layer                                    | Scope                                                                                                                                                                                   | Verification result                                                   |
| :--------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| **Lean 4 (`proofs/dad-test/`)**          | Reachability soundness & exactness, private-helper hunk attribution, fail-closed SQL/migration FK closure, `export * as ns` member tracking, bound import-line & new-module attribution | **36 theorems**, 0 `sorry`, standard axioms only (`lake build`)       |
| **Lean 4 ↔ Rust differential oracle**    | Compiled Lean 4 evaluator compared directly against `dad-test`                                                                                                                          | **6/6 suites**, 0 mismatches                                          |
| **Quint/TLA+ specs (`specs/dad-test/`)** | Snapshot store cache equivalence, DAG scheduler safety, L1 local & L2 remote content-hashed receipt soundness                                                                           | **100% trace replay parity** (`0` false cache hits, `0` false misses) |
| **Mutation soundness**                   | Real bugs injected across synthetic suites and 4 live repositories                                                                                                                      | **0 escaped mutants**                                                 |

### 7.2 Real-repository precision & speed

Measured with the release Rust binary (`dad-test`, parallel Oxc indexing) across public TypeScript repositories and a 20,095-file TypeScript monorepo:

| Repository                  | Scale                                      | Edit tested                                             | Package-level baseline |                                   `dad-test` selected | Speed & outcome                                           |
| :-------------------------- | :----------------------------------------- | :------------------------------------------------------ | ---------------------: | ----------------------------------------------------: | :-------------------------------------------------------- |
| **`remeda/remeda`**         | 579 TS, 179 test files                     | Comment edit (`clamp.ts`)                               |              179 files |                                           **0 files** | 146 ms (**100% skipped**)                                 |
| **`remeda/remeda`**         | 579 TS, 179 test files                     | Private helper bug (`clamp.ts`)                         |   179 files (3,344 ms) |                                   **1 file** (413 ms) | **99% skipped, 8× faster**, bug caught                    |
| **`fabian-hiller/valibot`** | 1,112 TS, 280 test files                   | Type-only edit (`email.ts`)                             |              280 files |                                   **0 runtime files** | 233 ms (**100% runtime skipped**)                         |
| **`fabian-hiller/valibot`** | 1,112 TS, 280 test files                   | Mutate `EMAIL_REGEX` in shared `regex.ts` (20+ exports) |              280 files |                                **9 files** (1,724 ms) | **97% skipped**, bug caught                               |
| **`dads-framework`**        | 20 pkgs, 2,095 TS, 642 test files          | Bug in `dst/prng.ts` (`--cache`)                        |     3 pkgs (128 files) |                          **3 / 40** in `testing-core` | 572 ms vs 2,105 ms full pkg (**93% skipped**), bug caught |
| **Enterprise TS monorepo**  | 20,095 files, 307 pkgs, 5,266 test files   | Small 3-file web PR                                     |    33 pkgs (987 files) |                               **19 pkgs (257 files)** | **74% fewer files**; 1.8 s cold / 0.4 s warm index        |
| **Enterprise TS monorepo**  | 43 Postgres suites (531 integration files) | Scoped table migration vs. global `DO $$` DDL           |                      — | **12/43** scoped (**72% skipped**) / **43/43** global | Fail-closed on global DDL                                 |

Reproduce the Lean 4 proofs and Rust/JS verification suites from any checkout:

```sh
cd proofs/dad-test && lake build
cargo test --workspace
node scripts/testing/verify-differential-oracle.mjs
node scripts/testing/verify-mutation-soundness.mjs
```
