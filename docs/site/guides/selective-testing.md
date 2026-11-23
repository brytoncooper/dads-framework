# Selective Testing (`dad-test`)

`@dads-framework/testing` (`dad-test`) is a sound selective test runner for TypeScript and JavaScript repositories. It sits in front of Vitest, Jest, and `tsc` and skips only what it can prove unaffected.

## Install and initialize

```sh
npm install --save-dev @dads-framework/testing
npx dad-test init
```

`dad-test init` inspects your workspace (`pnpm-workspace.yaml`, `package.json` workspaces, or `dads.project.json`) and generates `dads.testing.json` with task dependencies and Vitest file-level narrowing. For Nx workspaces, use `dad-test-nx plan` and `dad-test-nx run`.

## Commands

| Command             | Purpose                                                                                                                                                     |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dad-test plan`     | Decide which tasks and test files a Git diff requires without running them.                                                                                 |
| `dad-test run`      | Execute only the required tasks in dependency order. Pass `--cache` for local content-hashed receipts and `--remote-cache <url>` for shared L2 CI receipts. |
| `dad-test explain`  | Print the exact symbol, import, or widening cause (`file:line:col`) behind every `RUN` and `SKIP` decision.                                                 |
| `dad-test diagnose` | Scan a clean repository with no Git diff to rank widening culprits, runtime coupling hotspots, and fallback traps.                                          |

## What `dad-test` traces

`dad-test` parses your TypeScript and JavaScript in parallel using Rust and Oxc, tracing diffs across:

- **Comments and whitespace:** AST-preserving comment edits run zero tests and zero typecheck.
- **Type-only edits and `import type` edges:** Runtime test tasks skip cleanly while `typecheck` still runs.
- **Individual exports and private helpers:** Intra-file def-use traces edits to unexported helpers back to calling exports in pure top-level modules.
- **Namespace re-exports and import lines:** `export * as ns` member reads and bound import edits narrow cleanly while bare side-effect imports and escaped namespaces widen safely.
- **PostgreSQL migrations and schema snapshots:** Optional `workspace.sql` and per-task `sqlImpact` parse `.sql` files, `node-pg-migrate` builders and `.sql()` calls, and table-named schema snapshots across bidirectional foreign-key neighbors. Any global DDL (`DO $$`, `CREATE EXTENSION`, `ALTER PUBLICATION`) fails closed to every database task.

When `dad-test` encounters dynamic imports, ambiguous exports, or unowned files it cannot prove narrow, it widens out loud and cites the exact `file:line:col` responsible.

## Diagnose your repo before opening a PR

Run `dad-test diagnose` on any clean checkout to get a coupling and precision X-ray in under a second:

```sh
npx dad-test diagnose
```

`dad-test diagnose` reports:

1. **Effective vs. potential leaf skip rate:** What you skip today (accounting for workspace-wide and module-level widening) versus what you can skip after fixing widening culprits.
2. **Ranked widening culprits:** Exact `file:line:col` locations ordered by how many tasks and test files they widen.
3. **Runtime vs. typecheck coupling hotspots:** Shared modules and deep transitive hubs ranked by exact runtime test reach, separated from `import type` reach so you do not refactor type-only barrels by mistake.
4. **Fallback traps with safety guardrails:** Unowned directories and uncovered non-code files paired with safety-tiered remediations (`safe`, `verify-before-changing`, or `keep-widened-unless-verified`). Data, fixture, and schema suffixes (`.json`, `.txt`, `.yaml`, `.env`, `.sql`) are marked with explicit cautions against blindly adding them to `workspace.nonCodeSuffixes`.

## Local and remote receipt caching

```sh
# Local content-hashed passing receipts under Git metadata
npx dad-test run --cache

# Shared L2 remote receipt store across CI workers (file://, http://, or https://)
npx dad-test run --cache --remote-cache https://ci-cache.example.internal/receipts
```

Receipts hash task identity, command and arguments, `execution.env`, OS/arch/Node runtime fingerprint (`DADS_TESTING_RUNTIME_FINGERPRINT`), manifest and policy files, selected files, and transitive project inputs. Failing runs never write receipts, and corrupt or unreachable remote receipts fail closed to fresh execution.

## Proofs and package reference

- **Formal proofs and real-repo benchmarks:** [Benchmarks & Proof](benchmarks-and-proof.md#7-selective-testing-dad-test-benchmarks--formal-proof)
- **Full CLI, manifest schema, and DST API:** [`@dads-framework/testing` README](../../../packages/testing/core/README.md)
