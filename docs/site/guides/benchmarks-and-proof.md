# Benchmarks & Proof

Every critical rule in Dads is machine-checked before it ships: **63 zero-`sorry` Lean 4 theorems**, **3 Quint/TLA+ state-machine specs**, compiled differential oracles tested against the real engines, and reproducible benchmarks on real workloads.

> **Jump straight to a full report:**
>
> - **[Selective Testing (`dad-test`) Benchmarks & Proofs](testing-benchmarks.md)** — 36 Lean 4 theorems, 3 Quint/TLA+ specs, 0 escaped mutants, and live Nx comparisons across 5 real repos.
> - **[Access & Permissions Benchmarks & Proofs](access-benchmarks.md)** — 27 Lean 4 theorems, 299,200 differential oracle queries, 100M PostgreSQL rows on 1 vCPU, 10,000-hop chains, and SpiceDB comparisons.

---

## Proof Scorecard (At a Glance)

| Subsystem                                           | Formal Model                                                                                                       | Executable Oracle & Runtime Proof                                                                                                                                                                          | Source                                                                                                                        |
| :-------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| **Selective Testing (`dad-test`)**                  | **36 Lean 4 theorems** (0 `sorry`, standard axioms) + **3 Quint/TLA+ specs** (Apalache Z3 symbolic model checking) | Lean 4 ↔ Rust differential oracle (`6/6` suites, **0 mismatches**); 100% Quint trace replay parity on snapshot cache & L1/L2 remote receipts (`0` false cache hits); **0 escaped mutants** on 4 live repos | [`proofs/dad-test/`](../../../proofs/dad-test/DadTest.lean) · [`specs/dad-test/`](../../../specs/dad-test/snapshot_store.qnt) |
| **Access & Permissions (`@dads-framework/access`)** | **27 Lean 4 theorems** (0 `sorry`, standard axioms)                                                                | Compiled Lean 4 evaluator (`dads-access-oracle`) vs. PostgreSQL, SQLite, and in-memory across **1,300 schemas / 299,200 queries** (**0 mismatches**), plus live SpiceDB parity suites                      | [`formal/access-proofs/`](../../../formal/access-proofs/README.md)                                                            |

### Verify every proof yourself

```sh
# 1. Verify all 36 Lean 4 selective-testing proofs
(cd proofs/dad-test && lake build)

# 2. Verify all 27 Lean 4 access & SQL-compiler proofs
(cd formal/access-proofs && lake build)

# 3. Run the Lean 4 <-> Rust differential oracle and mutation soundness suite
node scripts/testing/verify-differential-oracle.mjs
node scripts/testing/verify-mutation-soundness.mjs
```

---

## Headline Benchmarks: Selective Testing (`dad-test`)

Measured with the release Rust binary (parallel Oxc indexing) against package-level affected runners (Nx) across open-source repos and an **Anonymous 20k-file TS monorepo** (20,095 files, 307 packages, 5,266 test files):

| Repository                                     | Edit tested                                 |   Package-level (Nx) |                            `dad-test` | Outcome                                                       |
| :--------------------------------------------- | :------------------------------------------ | -------------------: | ------------------------------------: | :------------------------------------------------------------ |
| **`remeda/remeda`** (179 test files)           | Private helper bug (`clamp.ts`)             | 179 files (3,344 ms) |                   **1 file** (413 ms) | **99% skipped, 8× faster**, bug caught                        |
| **`fabian-hiller/valibot`** (280 test files)   | Type-only edit (`email.ts`)                 |            280 files |          **0 runtime files** (233 ms) | **100% runtime skipped** (`typecheck` still runs)             |
| **`fabian-hiller/valibot`** (280 test files)   | Mutate `EMAIL_REGEX` in shared `regex.ts`   |            280 files |                **9 files** (1,724 ms) | **97% skipped**, bug caught                                   |
| **`dads-framework`** (20 pkgs, 642 test files) | Bug in `dst/prng.ts` (`--cache`)            |   3 pkgs (128 files) | **3 / 40** in `testing-core` (572 ms) | **93% skipped in pkg**, bug caught                            |
| **Anonymous 20k-file TS monorepo**             | Small 3-file web PR                         |  33 pkgs (987 files) |               **19 pkgs (257 files)** | **74% fewer files** · 1.8 s cold / 0.4 s warm index           |
| **Anonymous 20k-file TS monorepo**             | Scoped SQL migration vs. global `DO $$` DDL |                    — |   **12/43** scoped / **43/43** global | **72% of Postgres suites skipped**; fail-closed on global DDL |

[Read the full Selective Testing Benchmarks & Proofs report →](testing-benchmarks.md)

---

## Headline Benchmarks: Access & Permissions (PostgreSQL & SQLite)

Measured on a hard-capped **1 vCPU, 2 GB RAM** PostgreSQL 16 container (up to 100,000,000 rows / 22 GB), a **32-vCPU** consistent-read head-to-head vs. SpiceDB, and embedded Node 24 SQLite:

| Metric                                              | Measured result                                                                       | Context                                                                              |
| :-------------------------------------------------- | :------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------- |
| **10k → 100,000,000 rows (1 vCPU, 2 GB RAM)**       | **0.44 → 0.50 ms** point checks · **0.51–2.19 ms** `LIMIT 50` lists · **0 seq scans** | **2,505 checks/sec** sustained on 1 vCPU (~216M/day) at 22 GB (11× container RAM)    |
| **10,000 nested groups deep (1 vCPU)**              | **15.76 ms** allow · **0.34 ms** outsider deny                                        | Deleting middle link (#5,000) cuts off access immediately                            |
| **Storage vs. tuple-only stores (10M logged rows)** | **30 MB** vs. **2.73 GB** (**91× smaller**, ~600× projected at 100M)                  | Direct foreign-key columns (`columnRelations`), **8,274 checks/sec** on 3 vCPUs      |
| **Consistent reads vs. SpiceDB (32 vCPU)**          | **2.0×–3.2×** higher throughput · **2.3×–3.6×** lower p50 latency                     | `14,044–25,178 checks/sec` vs. SpiceDB `5,678–8,446 checks/sec` (`fully_consistent`) |
| **Embedded SQLite (100k rows)**                     | **0.03–0.04 ms** lists · **0.11 ms** depth-100 folders · **1.83 ms** / 1k checks      | In-process Node 24 `node:sqlite`, 1M-path diamond DAG in **0.06 ms**                 |

[Read the full Access & Permissions Benchmarks & Proofs report →](access-benchmarks.md)
