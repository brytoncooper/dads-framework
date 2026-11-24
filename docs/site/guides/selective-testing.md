# Selective Testing & TIA (`dad-test`)

`@dads-framework/testing` (`dad-test`) is a proof-backed **Test Impact Analysis (TIA)** engine — and more — for TypeScript and JavaScript repositories. It sits in front of Vitest, Jest, `tsc`, and lint/build steps and skips only what it can prove unaffected.

## How it connects to Dads (and works without it)

Dads is built on one rule: **enforce clean boundaries and prove every claim instead of guessing**.

- **Inside a Dads app:** Because Dads already isolates features into `domains/*`, separates `pure/` logic from `server/` adapters, and tracks PostgreSQL migrations per domain, `dad-test init` wires per-domain projects, Vitest file-level narrowing, and deterministic simulation tests out of the box. Every clean boundary directly translates into faster CI.
- **Standalone in any TypeScript repo:** You do not need the Dads backend framework to use `dad-test`. Drop it in front of any npm, pnpm, Yarn, or Nx repository (`dad-test init` or `dad-test-nx`) to cut CI runtime and surface hidden coupling.

## Why it is more than standard TIA

Classic Test Impact Analysis tools stop at package-level affected graphs or probabilistic test skipping. `@dads-framework/testing` combines five capabilities under one fail-closed engine:

1. **Proof-backed symbol, helper, and file TIA:** Parsed in parallel with Rust and Oxc, backed by **36 machine-checked Lean 4 theorems** and **Quint/TLA+ specs**. Traces diffs down to individual exports, private helpers, namespace re-exports, `import type` edges, and individual test files — widening out loud with `file:line:col` whenever static proof runs out.
2. **PostgreSQL migration & table-level narrowing:** Optional `workspace.sql` and per-task `sqlImpact` parse `.sql` files, `node-pg-migrate` builders and `.sql()` calls, and table-named schema snapshots across bidirectional foreign-key neighbors. Global DDL (`DO $$`, `CREATE EXTENSION`, `ALTER PUBLICATION`) fails closed to every database suite.
3. **Repo coupling & precision X-ray (`dad-test diagnose`):** Runs on a clean checkout with no diff to measure effective vs. potential leaf-edit skip rates, rank widening culprits by blast radius, separate real runtime coupling from `import type`, and pair every finding with safety-tiered fix guides and explicit guardrails.
4. **Content-hashed local & remote receipt caching (`--cache`, `--remote-cache`):** Shares verified passing receipts across local runs and CI workers (`file://`, `http://`, `https://`), keyed on source files, manifest, policy files, command, `execution.env`, and OS/arch/Node runtime fingerprint.
5. **Deterministic Simulation Testing (`@dads-framework/testing/dst`):** Seeded simulation worlds (`createSimWorld`, `runSimulation`), delta-debugging shrinking, and fault-injecting adapters for Postgres serialization retries (`40001`/`40P01`), expiring tokens, duplicate/reordered queues, and mid-stream SSE revocations.

## Install and initialize

```sh
npm install --save-dev @dads-framework/testing
npx dad-test init
```

`dad-test init` inspects `pnpm-workspace.yaml`, `package.json` workspaces, or `dads.project.json` and writes `dads.testing.json` (using symbol-level `reachability` for both `test` and `typecheck`). For Nx workspaces, no manifest is required: run `npx dad-test diagnose` (which auto-detects `nx.json`) or `npx dad-test-nx diagnose|plan|run` for full Oxc symbol-level reachability directly against the live Nx project graph.

## Commands

| Command             | Purpose                                                                                                                                      |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `dad-test plan`     | Decide which tasks and test files a Git diff requires without running them.                                                                  |
| `dad-test run`      | Execute only the required tasks in dependency order. Pass `--cache` for local receipts and `--remote-cache <url>` for shared L2 CI receipts. |
| `dad-test explain`  | Print the exact symbol, import, or widening cause (`file:line:col`) behind every `RUN` and `SKIP` decision.                                  |
| `dad-test diagnose` | Scan a clean repository with no Git diff to rank widening culprits, runtime coupling hotspots, and fallback traps.                           |

## Diagnose your repo before opening a PR

```sh
npx dad-test diagnose
```

`dad-test diagnose` reports:

- **Effective vs. potential leaf skip rate:** What you skip today (accounting for workspace-wide and module-level widening) versus what you can skip after fixing widening culprits.
- **Ranked widening culprits:** Exact `file:line:col` locations ordered by how many tasks and test files they widen.
- **Runtime vs. typecheck coupling hotspots:** Shared modules and deep transitive hubs ranked by exact runtime test reach, separated from `import type` reach so you do not refactor type-only barrels by mistake.
- **Fallback traps with safety guardrails:** Unowned directories and uncovered non-code files paired with safety-tiered remediations (`safe`, `verify-before-changing`, or `keep-widened-unless-verified`). Data, fixture, and schema suffixes (`.json`, `.txt`, `.yaml`, `.env`, `.sql`) carry explicit cautions against blindly adding them to `workspace.nonCodeSuffixes`.

## Leaving Nx cleanly (3-stage exit ramp)

For Nx monorepos, you do not need to rip out Nx on day one — and you do not have to stay on Nx's project-graph cache forever:

```sh
# 1. Day 1 (zero edits): get the coupling X-ray and symbol-level planning in place
npx dad-test diagnose
npx dad-test-nx plan --base origin/main

# 2. Preview ejecting off Nx (dry-run — writes nothing)
npx dad-test-nx eject

# 3. Eject to a standalone zero-Nx dads.testing.json + swap nxViteTsPaths() -> dadsTsconfigPaths()
npx dad-test-nx eject --write --replace-nx-vite-paths

# 4. Verify standalone dad-test with per-file Vitest narrowing and L1/L2 receipts, then uninstall Nx
npx dad-test plan --base origin/main
npx dad-test run --base origin/main --cache
```

`dad-test-nx eject` materializes plugin-inferred Vitest, ESLint, TypeScript, and `nx:run-commands` targets into standalone commands, wires per-file Vitest narrowing (disabling narrowing fail-closed if a config uses dynamic `setupFiles`), preserves pure-check prerequisites via `dependsOn`, audits any remaining opaque executors honestly, and prints exact uninstall commands for `nx` and `@nx/*`.

## Local and remote receipt caching

```sh
# Local content-hashed passing receipts under Git metadata
npx dad-test run --cache

# Shared L2 remote receipt store across CI workers (file://, http://, or https://)
npx dad-test run --cache --remote-cache https://ci-cache.example.internal/receipts
```

Failing runs never write receipts, and corrupt or unreachable remote receipts fail closed to fresh execution.

## Proofs and package reference

- **Formal proofs and real-repo benchmarks:** [Testing Benchmarks & Proofs](testing-benchmarks.md) · [All Proofs Overview](benchmarks-and-proof.md)
- **Full CLI, manifest schema, and DST API:** [`@dads-framework/testing` README](../../../packages/testing/core/README.md)
