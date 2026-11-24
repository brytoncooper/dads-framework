# Selective Testing (`dad-test`) Benchmarks & Proofs

`@dads-framework/testing` (`dad-test`) proves its selection, widening, and receipt-caching rules in **36 zero-`sorry` Lean 4 theorems** and **3 Quint/TLA+ state-machine specs**, then checks the compiled Rust binary against those specs and real repositories.

> **Back to overview:** [Benchmarks & Proof](benchmarks-and-proof.md) · **Usage guide:** [Selective Testing & TIA (`dad-test`)](selective-testing.md)

---

## 1. Formal Proofs (36 Lean 4 Theorems + 3 Quint/TLA+ Specs)

Every precision optimization is proved sound before it enters the Rust engine. All 36 Lean 4 theorems build with zero `sorry` and standard axioms only (`[propext, Classical.choice, Quot.sound]`):

| Proof module                                                                                                                                        | Theorems | What is proved                                                                                                                                                                     |
| :-------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`DadTest/Reachability.lean`](../../../proofs/dad-test/DadTest/Reachability.lean) & [`Planner.lean`](../../../proofs/dad-test/DadTest/Planner.lean) |   **15** | `no_false_task_skips`, `no_false_file_skips`, `uncertainty_widens_to_all_tests`, `unowned_changed_forces_full_fallback`, exact `↔` reachability, comment-only edits run zero tests |
| [`DadTest/PrivateHelper.lean`](../../../proofs/dad-test/DadTest/PrivateHelper.lean)                                                                 |    **5** | Reverse intra-file def-use attributes private-helper edits to calling exports in pure top-level modules; impure top-level modules widen conservatively                             |
| [`DadTest/SqlMigration.lean`](../../../proofs/dad-test/DadTest/SqlMigration.lean)                                                                   |    **6** | Bidirectional foreign-key table closure selects every impacted database task; global DDL, unmapped tables, and unannotated tasks fail closed to all DB tasks                       |
| [`DadTest/NamespaceAndImports.lean`](../../../proofs/dad-test/DadTest/NamespaceAndImports.lean)                                                     |   **10** | `export * as ns` tracked member-read soundness and escape widening; bound import-line narrowing vs. bare side-effect widening; newly-added pure vs. impure modules                 |

### Stateful & concurrent specs (Quint / TLA+)

| Spec                                                                                 | Verified invariants                                                                                                                      | Runtime parity proof                                                                  |
| :----------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| [`snapshot_store.qnt`](../../../specs/dad-test/snapshot_store.qnt)                   | Cache equivalence (`warm == cold`), persisted integrity, receipt soundness, incremental patch precision (Apalache Z3 symbolic `NoError`) | `52/52` live ITF trace replay checks (`0` divergences)                                |
| [`scheduler.qnt`](../../../specs/dad-test/scheduler.qnt)                             | Concurrency job limit, prerequisite DAG order, no deadlock, sound tally & exit codes (Apalache Z3 exhaustive `NoError`)                  | Verified across DAG blocking & parallel Rust scheduler tests                          |
| [`remote_receipts_and_env.qnt`](../../../specs/dad-test/remote_receipts_and_env.qnt) | Cross-worker L1 + L2 remote receipt soundness under env/runtime/source changes and corrupt stores (5,000 traces + Apalache Z3 `NoError`) | `100%` multi-worker parity (`100` L1 hits, `10` L2 hits, `70` misses, `0` false hits) |

### Differential oracle & mutation soundness

- **Lean 4 ↔ Rust differential oracle (`verify-differential-oracle.mjs`):** `6/6` suites exact match (diamond `export *`, intra-file def-use, `import type` erasure, tracked vs. escaped namespace imports, comment-only edits, leaf `.test.ts`, `setupFiles`, unowned full fallback).
- **Mutation soundness (`verify-mutation-soundness.mjs` + 4 live repos):** **0 escaped mutants** — every injected runtime bug failed its narrowed test suite and invalidated cached receipts.
- **Parallel Oxc determinism (`parallel_determinism.rs`):** 8 cold + 6 incremental parallel workspace runs produce bit-for-bit identical graph JSON.

---

## 2. Live Comparisons vs. Nx & Package-Level Affected

### 2.1 Anonymous 20k-file TypeScript monorepo (307 packages, 5,266 test files)

Measured directly against real `nx show projects --affected` on 5 historical PRs and 2 PostgreSQL migration scenarios:

| Change                                                |                        Nx affected |                         `dad-test` | Difference                                                   |
| :---------------------------------------------------- | ---------------------------------: | ---------------------------------: | :----------------------------------------------------------- |
| Small web fix (3 files)                               |            33 pkgs (**987** files) |            19 pkgs (**257** files) | **74% fewer files**                                          |
| Feature PR (30 files)                                 |           57 pkgs (**2,230** unit) |             23 pkgs (**939** unit) | **58% fewer unit files**                                     |
| Medium migration PR (77 files)                        |           96 pkgs (**3,425** unit) |           77 pkgs (**2,979** unit) | **13% fewer unit files**                                     |
| Big migration PR (142 files)                          | 99 pkgs (**2,217** unit / 522 int) | 71 pkgs (**2,018** unit / 531 int) | **9% fewer unit**, caught **+9** integration files Nx missed |
| Scoped SQL migration (`ALTER TABLE` + grant snapshot) |            10 / 43 Postgres suites |        **12 / 43** Postgres suites | **72% of DB suites skipped** (catches 2 unmapped dependents) |
| Global SQL migration (`DO $$ ALTER PUBLICATION`)      |     owning package dependents only |        **43 / 43** Postgres suites | **Fail-closed** (Nx silently skips unrelated DB suites)      |

**Indexing speed on 20,095 files:** **1,836 ms** cold (2.5× faster with parallel Oxc), **391 ms** warm.

### 2.2 Open-source & multi-package repositories

Package-level affected runners run every test file in a changed package (and its dependent packages). `dad-test` traces symbols, private helpers, and `import type` inside each package:

| Repository                                             | Edit                                                         |   Package-level (Nx) |                                        `dad-test` | Result                                 |
| :----------------------------------------------------- | :----------------------------------------------------------- | -------------------: | ------------------------------------------------: | :------------------------------------- |
| **`remeda/remeda`** (579 TS, 179 test files)           | Comment edit (`clamp.ts`)                                    |            179 files |                              **0 files** (146 ms) | **100% skipped**                       |
|                                                        | Private helper bug (`clamp.ts`)                              | 179 files (3,344 ms) |                               **1 file** (413 ms) | **99% skipped, 8× faster**, bug caught |
|                                                        | Unresolved `type-fest` import (`chunk.ts`)                   |            179 files |                  **179 files** (widened out loud) | Fail-closed + cites `chunk.ts`         |
| **`fabian-hiller/valibot`** (1,112 TS, 280 test files) | Comment edit (`email.ts`)                                    |            280 files |                              **0 files** (227 ms) | **100% skipped**                       |
|                                                        | Type-only edit (`email.ts`)                                  |            280 files |                      **0 runtime files** (233 ms) | **100% runtime skipped**               |
|                                                        | Mutate only `EMAIL_REGEX` in shared `regex.ts` (20+ exports) |            280 files |                            **9 files** (1,724 ms) | **97% skipped**, bug caught            |
| **`dads-framework`** (20 pkgs, 642 test files)         | Comment edit (`dst/prng.ts`)                                 |   3 pkgs (128 files) |                              **0 files** (197 ms) | **100% skipped**                       |
|                                                        | Bug in `dst/prng.ts` (`--cache`)                             |   3 pkgs (128 files) | **3 / 40** in `testing-core` (572 ms vs 2,105 ms) | **93% skipped in pkg**, bug caught     |
|                                                        | Bug in `plan-reasons.ts` (`--cache`)                         |   3 pkgs (128 files) |                      **8 / 40** in `testing-core` | **80% skipped in pkg**, bug caught     |
| **`apps/kit-workbench`** (10 unit/DST + integration)   | Comment edit                                                 |        10 unit + int |                              **0 files** (119 ms) | **100% skipped**                       |
|                                                        | Leaf bug (`note-rules.ts`)                                   |        10 unit files |              **2 files** (warm `--cache`: 119 ms) | **80% skipped**, bug caught            |

---

## 3. Live `dad-test diagnose` X-Ray Results

Running `dad-test diagnose` on clean checkouts with no Git diff:

| Repository                         |       Cold / Warm | Effective → Potential Leaf Skip   | Top X-ray finding                                                                                                                   |
| :--------------------------------- | ----------------: | :-------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous 20k-file TS monorepo** | 1,836 ms / 742 ms | **1.1% today → 97.1% potential**  | Pinpointed all 15 workspace-wide `nonliteral-dynamic-import` sites + deep shared ID hubs (**2,799 runtime** / **3,111 with types**) |
| **`fabian-hiller/valibot`**        |   228 ms / 143 ms | **82.8% today → 84.3% potential** | 0 workspace-wide culprits; surfaced deep internal utils (`_formatCase.ts`: **235 runtime** / **269 with types**)                    |

---

## 4. Reproduce Everything

```sh
# 1. Machine-check all 36 Lean 4 theorems (0 sorry)
(cd proofs/dad-test && lake build)

# 2. Run all Rust core, JS frontend, store, and parallel-determinism tests
cargo test --workspace

# 3. Run Lean 4 <-> Rust differential oracle, mutation soundness, and Quint receipt replays
node scripts/testing/verify-differential-oracle.mjs
node scripts/testing/verify-mutation-soundness.mjs
node scripts/testing/verify-quint-receipt-replay.mjs
node scripts/testing/verify-quint-remote-receipts.mjs
```
