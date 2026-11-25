# Changelog

This file records notable changes to Dads Framework.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [@dads-framework/testing 0.8.2] - 2026-11-25

Independent soundness & precision patch release of `@dads-framework/testing` and its five `@dads-framework/testing-native-*` packages (framework packages remain at `0.6.5`).

### Fixed

- **Single-source-of-truth planner → receipt cache input closure (`dads-testing-receipt-v4`):** The planner now emits authoritative `cacheInputs` (`cacheable`, `projectRoots`, `impactPaths`, `extraFiles`) on every runnable `TaskDecision` (carried through `--plan-file`), and `FileReceiptStore` hashes all Oxc-imported dependency projects, `fallbackDependencies`, `task.impact.paths` (exact files, directories, and globs), `sql_impact` roots/snapshots, `setupFiles`, and root `tsconfig*.json` / workspace config files. Tasks with incomplete closures (`impact.mode: "always"`, `fullFallback`, missing graph, or unscoped dynamic imports on the forward closure) fail closed (`cacheable: false`). Receipt key domain bumped from `v3` to `v4`.
- **Unified Oxc + `fallbackDependencies` project widening:** Uncertainty widening (`propagate_fallback_dependents`) and `dad-test diagnose` closures now union Oxc cross-project imports with declared `fallbackDependencies` so projects without manual `implicitDependencies` never silently skip downstream dependents on uncertainties.
- **Top-level module-evaluation side-effect soundness (`module_eval_changed`):** Impure export initializers (`export const marker = setRate(5)`, `export const marker = (shared.factor = 5)`), class static blocks/impure static fields, private helpers called by impure top-level statements, and added/changed runtime imports now propagate transitively across all runtime import edges (preserving `import type` erasure and file-level Vitest narrowing), backed by updated Lean 4 proofs (`lake build`, 0 `sorry`s, 6/6 differential oracle) and an expanded 28-case release soundness corpus (0 false negatives, 0 skipped changed outcomes).
- **First-class static non-JS imports & native static `fs` / `import.meta.glob` edges:** Static imports of workspace non-JS files (`.json`, `.css`, `.sql`, etc.) and statically resolvable `fs` file/directory reads (`readFileSync`, `readFile`, `readdirSync`, `readdir`, `existsSync`, `statSync`, `new URL(..., import.meta.url)`, `join`/`resolve` from `__dirname`/`import.meta.dirname`, `import.meta.glob`) are now wired directly into the Oxc graph without false `check-boundaries` violations or manual `impact.paths`.
- **Task failure output streaming:** Failing tasks now stream tails from both `stdout` (last 30 lines) and `stderr` (last 20 lines) so Vitest assertion failures are never masked behind stderr noise.

### Added

- **Purity narrowing (`/*#__PURE__*/`, pure built-ins, and `workspace.pureFactories`):** Supports standard `/*#__PURE__*/`/`/*@__PURE__*/` annotations, unshadowed pure JS built-ins (`Object.freeze`, `Symbol`, pure `RegExp`/`Set`/`Map`), and optional manifest `workspace.pureFactories` (e.g. `["z.*", "pgTable", "createContext"]`) so pure declarative schema/component factories stay symbol-narrow.

## [@dads-framework/testing 0.8.1] - 2026-11-24

Independent patch release of `@dads-framework/testing` and its five `@dads-framework/testing-native-*` packages (framework packages remain at `0.6.5`).

### Added

- **Full ESLint boundary parity in `dad-test check-boundaries`:** Added `banTransitiveDependencies` (checks nearest enclosing and root `package.json` dependency declarations) plus `ignorePaths` and `excludeProjects` scoping on `workspace.boundaries`.

### Fixed

- **Native package `"bin"` collision:** Removed the duplicate `"bin": { "dad-test": ... }` field from all five `@dads-framework/testing-native-*` optional packages so incremental `npm install` never overwrites `@dads-framework/testing`'s JS CLI wrapper symlink.

## [@dads-framework/testing 0.8.0] - 2026-11-24

Independent feature release of `@dads-framework/testing` and its five `@dads-framework/testing-native-*` packages (framework packages remain at `0.6.5`).

### Added

- **Native Rust module-boundary enforcement (`dad-test check-boundaries`):** Checks `depConstraints` (`sourceTag`, `onlyDependOnLibsWithTags`, `notDependOnLibsWithTags`, `bannedExternalImports`, `allowedExternalImports`), `allow`, `allowCircularSelfDependency`, `enforceBuildableLibDependency`, `checkNestedImports`, and cycles directly on the Oxc workspace graph (declared in `workspace.boundaries` or `--config <path>`, full workspace or `--base`/`--head`).
- **Per-alias `tsconfig*.json` (`compilerOptions.paths`) narrowing:** When a workspace `tsconfig` changes only `compilerOptions.paths`, `dad-test` lifts global widening and marks only files/projects referencing the added, modified, or removed path aliases (and their reverse-reachable dependents) as affected; non-`paths` edits and malformed JSONC stay strictly fail-closed.
- **Vitest file-batching (`execution.batch.mode: "vitest-files"` & `autoVitestBatching`):** Groups compatible narrowed Vitest tasks into a single Vitest run with `--reporter=json` per-task pass/fail/duration attribution and selective caching of passing tasks.
- **Project-grouped deterministic LPT sharding & `--plan-file` reuse:** `--shard <index>/<total>` uses deterministic project-grouped LPT bin-packing, emits `plan.shard` metadata, accepts nested `{ projects: { <id>: { durationMs } } }` `--weights` JSON, and `dad-test run --plan-file <path>` reuses a precomputed plan without re-running `git diff` or Oxc graph analysis.
- **Shared local disk cache (`--cache-dir` / `DAD_TEST_CACHE_DIR`):** Shares workspace-relative content-hashed receipts safely across git worktrees and parallel local processes using atomic temp-file writes (`O_CREAT | O_EXCL` + `rename`).
- **Graph blast-radius & barrel hotspots (`dad-test hotspots`):** Ranks highest-blast-radius files, Oxc-detected barrel re-export hubs, and projects (`--limit`, `--min-projects`, `--barrels-only`, `--json`).
- **`dad-test diagnose` CI ratchet flags:** Uncapped `workspaceUncertainties`, `--max-workspace-uncertainties <N>`, `--fail-on-workspace-uncertainties`, `--max-unowned-files <N>`, and copy-pasteable `workspace.dynamicImportScopes` remediation snippets.

## [@dads-framework/testing 0.7.1] - 2026-11-24

Independent patch release of `@dads-framework/testing` and its five `@dads-framework/testing-native-*` packages (framework packages remain at `0.6.5`).

### Added

- **Declarative `workspace.ignorePaths`:** Unowned non-JS paths matching `workspace.ignorePaths` (e.g. `docs/**`, mobile apps, agent metadata) are skipped cleanly instead of triggering `unknown-changed-path` full fallback.
- **Per-task `cache: false` and `taskOverrides.{cwd,args,cache}`:** Manifest tasks and declarative `taskOverrides` can now disable local/S3 receipt caching per task and override `cwd`/`args` directly without duplicating full task blocks under `tasks`.

### Changed

- **Auto-discover `implicitDependencies`:** `workspace.discover` now reads `implicitDependencies` from discovered `project.json` files into `fallbackDependencies` (skipping `!` negations and pruning unknown/excluded IDs).
- **Dual-tier `autoVitestNarrowing` excludes:** Projects declaring both `test` and `test:integration` (or `test:e2e`) automatically exclude `.integration.test.{ts,tsx}` and `.e2e.test.{ts,tsx}` from unit `:test` file narrowing.

### Fixed

- **`@dads-framework/testing/eslint` (`enforce-module-boundaries`):** Added `TSImportType` and `TSImportEqualsDeclaration` AST visitors and stripped comments, template literals, and non-import string literals before scanning alias dependencies for circular-dependency detection.

## [@dads-framework/testing 0.7.0] - 2026-11-24

Independent release of `@dads-framework/testing` and its five `@dads-framework/testing-native-*` packages (framework packages remain at `0.6.5`).

### Added

- **Decoupled testing release track:** `Prepare npm release artifacts` (`scope: testing`) and the release scripts now package, verify, and Sigstore-sign the 6 `@dads-framework/testing` packages independently from the 18 framework packages.
- **Declarative workspace discovery (`workspace.discover`) & `dad-test expand`:** Automatically expands JSONC `project.json` files using `namedImpacts`, `targetTemplates`, `dependsOnIfExists`, `taskOverrides`, `autoVitestNarrowing`, and automatic `fullFallback.taskIds`, with snapshot-digest invalidation so repos no longer maintain giant static manifests.
- **Explicit-only `--only` scope:** `dad-test plan|run|explain --only` runs strictly the requested `--task`, `--project`, `--target`, or `--kind` selectors plus their `dependsOn` prerequisites without running a git diff or Oxc graph scan.
- **Native CLI filters, weighted sharding & task batching:** Added `--target`, `--project`, `--exclude`, `--weights <file>` (LPT bin-packing), native Git `EMPTY_TREE` handling, and `execution.batch` with automatic individual failure isolation.
- **Zero-dependency Nx replacement companions:** Added `@dads-framework/testing/esbuild` (esbuild Node bundler + lockfileVersion 3 pruner), `@dads-framework/testing/eslint` (`enforce-module-boundaries` rule), and `scripts/testing/fetch-native-binary.mjs` for standalone CI binary fetching.

### Changed

- **Default live human streaming:** `dad-test run` now streams `[dad-test] START / CACHED / PASS / FAIL` lines and failing task output to `stderr` by default in non-`--json` mode and prints a one-line summary to `stdout` instead of dumping JSON; `--json` remains clean on `stdout`.
- **Parallel receipt hashing & S3 cache acceleration:** Memoized per-run `git ls-files`, manifest bytes, and file SHA-256 hashes; added single-pass S3 `list-objects-v2` pre-indexing (up to 100k keys / 10s budget), parallel receipt hashing and L2 GETs, 8 background L2 PUT workers, and skipped Oxc graph analysis on `--all`, `--only`, and `EMPTY_TREE`.

### Fixed

- **Refuse `--all` + `--task` footgun:** Combining `--all` with `--task` now fails loudly instead of silently selecting every task in the manifest.
- **Vitest `run` & `fileNarrowing`:** Both `dad-test-nx eject` and declarative `autoVitestNarrowing` normalize bare `vitest` commands to `vitest run` and wire `fileNarrowing` plus static `setupFiles` detection (failing closed on dynamic `setupFiles`).
- **`dad-test-nx eject` hygiene:** Extracts leading `KEY=VAL` env prefixes into `execution.env` and strips root lockfiles from per-task `impact.paths`.

## [0.6.5] - 2026-11-24

### Added

- Added native `s3://bucket/prefix` support to `dad-test`'s fail-closed L2 remote receipt cache (`--remote-cache` / `DADS_TESTING_REMOTE_CACHE_URL`).
- Added Lean 4-proved lockfile package-diff narrowing (`proofs/dad-test/DadTest/LockfileNarrowing.lean` + `crates/dads-testing-core/src/lockfile_impact.rs`): diffs `package-lock.json` (v3) packages, closes changed packages upward through transitive npm dependency edges, fails closed on parse errors, non-dependency `package.json` edits, or global toolchain packages (`typescript`, `vitest`, `eslint`, `@types/*`, etc.), and seeds only workspace modules importing an impacted package.
- Added `--kind <test|typecheck|lint|build|custom>` (repeatable) and `--shard <index>/<total>` deterministic round-robin sharding to `dad-test plan` and `dad-test run`.

## [0.6.4] - 2026-11-24

### Added

- Isolated test-file widening uncertainties (`is_isolated_test_file`): unimported test/spec files with dynamic imports or unresolved edges now widen only their own owning project instead of cascading to downstream dependents.
- Added `workspace.dynamicImportScopes` with segment-aware `*` and `**` glob matching (also supported in `impact.paths`), allowing known runtime plugin/migration loaders to declare their exact scanned directory prefixes while still widening whenever the loader file itself changes.

### Fixed

- Fixed JavaScript/TypeScript CommonJS `require()` scanning (`frontend_version = 14`) so member method calls such as `obj.require(...)`, string literals, and comments are no longer misclassified as dynamic CommonJS `require()` expressions.
- Fixed ESM/CJS specifier resolution in `dads-testing-javascript` to map `.mjs` → `.mts` and `.cjs` → `.cts` source files and resolve `@types/*` ambient type packages cleanly.
- Skipped runtime export-ownership widening checks on TypeScript ambient declaration files (`.d.ts`, `.d.mts`, `.d.cts`; `frontend_version = 15`).
- Preserved `*`/`**` globs in Nx native input expansion (`nx-native-input-expansion.ts`) instead of truncating patterns to parent directories.
- Upgraded `dad-test-nx eject` so ejected `lint` tasks use full `reachability` (catching cross-project type-aware lint rules).
- Skipped creating a cold ephemeral Git worktree in `dad-test-nx diagnose` when the working tree is clean, eliminating the 0.6.3 diagnose latency regression.

## [0.6.3] - 2026-11-23

### Added

- Isolated Nx diagnosis and revision-range planning in ephemeral detached Git worktrees (`os.tmpdir()`): `dad-test diagnose` / `dad-test-nx diagnose`, `dad-test-nx plan --base <A> --head <B>`, and `dad-test-nx plan --snapshot` now run against an immutable commit snapshot while symlinking `node_modules`, so concurrent edits on shared checkouts never interrupt discovery or planning.

### Fixed

- Fixed `dad-test-nx eject` emitting `execution.cwd: ""` for `nx:run-commands` targets with empty or `{workspaceRoot}` working directories (now normalized to workspace root `"."`).
- Aligned `dad-test diagnose` widening calculations with `plan`: project-owned `WholeWorkspace` dynamic-import uncertainties now report and widen only their owning project's declared dependency closure instead of claiming every reachability project in the workspace (`0%` effective skip).
- Stopped flagging standard tool configuration files (`*.config.{js,mjs,cjs,ts,mts,cts}`, `.eslintrc.*`, `.prettierrc.*`) as actionable `ambiguous-default-export` culprits with a `"safe"` fix while preserving sound widening when those config files change.
- Preserved colons in Nx target names (e.g. `domain-access:test:integration` instead of `domain-access:_test_3a_integration`) via collision-free `dadsTargetIdentifier` / `dadsTaskIdentifier`.

## [0.6.2] - 2026-11-23

### Fixed

- Switched JavaScript/TypeScript file discovery in `dads-testing-javascript` (`frontend_version = 13`) and receipt input hashing in `dads-testing-store` to use `git ls-files --cached --others --exclude-standard -z` inside Git repositories, so gitignored build outputs (such as `cdk.out`, `.nx`, `.turbo`) and nested agent worktrees (such as `.claude/worktrees/`) are never scanned, parsed, or allowed to inject phantom widening uncertainties. Non-Git fixtures fall back cleanly to directory traversal with an expanded ignore list.

## [0.6.1] - 2026-11-23

### Added

- Added `dad-test-nx eject` (and `ejectNativeNxTesting` in `@dads-framework/testing/nx`), a one-command exit ramp off Nx that converts plugin-inferred Vitest, ESLint, TypeScript, and `nx:run-commands` targets into a standalone zero-Nx `dads.testing.json` with automatic fail-closed Vitest `fileNarrowing`, pure-check `dependsOn` wiring, optional `--replace-nx-vite-paths` codemod (`nxViteTsPaths()` → `dadsTsconfigPaths()`), and an uninstall checklist.
- Added `dad-test-nx diagnose` (and `diagnoseNativeNxTesting`) plus automatic Nx detection in `dad-test diagnose` when no `dads.testing.json` exists and `nx.json` is present.
- Added destructured static `await import("./mod")` and tracked member-read narrowing in `dads-testing-javascript` (`frontend_version = 12`), preserving conservative widening for bare side-effect imports and rest spreads.
- Added `dad-test-nx --help` and expanded inline `dad-test --help` usage output.

### Changed

- Upgraded `dad-test-nx` (`buildNativeNxManifest`) so `test`, `typecheck`, and `build` targets use full Oxc symbol-level `reachability` with extra non-graph Nx `impact.paths` (honored explicitly by `dads-testing-core` `ImpactMode::Reachability`), while `lint` stays on `changed-files`.
- Separated pure-check Nx prerequisites (targets with `outputs: []` or `lint`/`test`/`typecheck` targets without declared outputs, such as repo-wide wall checks) into standalone `dependsOn` tasks so they run once instead of widening every unaffected project.
- Replaced hex-encoded Nx identifiers (`nx-61-63-...`) with readable, collision-free reversible identifiers (`dadsIdentifier` / `decodeDadsIdentifier`, e.g. `api:test`).
- Reused Nx's warm `.nx/workspace-data` plugin cache when `.nx/` is gitignored instead of forcing a cold scratch scan on every `dad-test-nx` invocation.
- Upgraded `dad-test init` to emit `impact.mode: "reachability"` for `typecheck` tasks so comment-only edits skip both `test` and `typecheck`.
- Improved `dad-test diagnose` pluralization, leaf-module coupling advice thresholds, and workspace-wide widening labels.

## [0.6.0] - 2026-11-23

### Added

- Added `dad-test diagnose` (and `diagnoseTesting` / `renderDiagnosis` in `@dads-framework/testing`), a read-only coupling and precision X-ray that scans a clean workspace without a Git diff and reports effective-today vs. potential leaf-edit skip rates, widening culprits with exact `file:line:col` blast radius, exact runtime vs. `import type` coupling hotspots, fallback traps, and safety-tiered remediations (`safe`, `verify-before-changing`, `keep-widened-unless-verified`) with explicit soundness cautions.
- Added formally proved precision narrowing in `@dads-framework/testing` backed by 36 machine-checked Lean 4 theorems (`proofs/dad-test/`, zero `sorry`) and Quint/TLA+ state-machine specs (`specs/dad-test/`):
  - Private-helper hunk attribution via reverse intra-file def-use in pure top-level modules (`PrivateHelper.lean`).
  - Fail-closed SQL and migration table-level impact analysis (`workspace.sql`, per-task `sqlImpact`, bidirectional FK closure, `.sql`, `node-pg-migrate` builders and `.sql()` calls, and table-named schema snapshots; `SqlMigration.lean`).
  - `export * as ns` tracked member-read narrowing, bound import-line edit attribution, and newly-added pure module attribution (`NamespaceAndImports.lean`).
- Added first-class `execution.env`, runtime environment fingerprinting (`DADS_TESTING_RUNTIME_FINGERPRINT`), opt-in `workspace.nonCodeSuffixes`, and fail-closed L2 remote receipt stores (`--remote-cache <url>` / `DADS_TESTING_REMOTE_CACHE_URL`, supporting `file://`, `http://`, and `https://`) verified against multi-worker Quint traces (`remote_receipts_and_env.qnt`).
- Added `dad migrate 0.6` support in `@dads-framework/toolbox`.

### Changed

- Parallelized Oxc workspace indexing in `dads-testing-javascript` (`frontend_version = 11`) using `std::thread::scope` with zero new Cargo dependencies and deterministic index-sorted output (~2.5x faster cold indexing on 20,000-file monorepos).
- Scoped uncovered-path widening in `dads-testing-core` to owners of uncovered paths rather than widening every changed project.

## [0.5.2] - 2026-11-23

### Added

- Added the browser-safe `@dads-framework/identity/tenants/contract` subpath so web clients can import tenant wire schemas without pulling Node or PostgreSQL dependencies into browser bundles.
- Added RFC 4180 CSV parsers (`parseCsv` and `parseCsvRecords`) to `@dads-framework/documents/csv`.
- Added `filterColumnRelationsForModel` and the named `DrizzleTransaction<Db>` type export to `@dads-framework/postgres-access`.
- Added `SseStream.close()` / `readonly closed`, periodic re-authorization (`recheckIntervalMs`) and immediate stream teardown on revoked channel/scope grants in `@dads-framework/http/channels`, and optional `redactError` hooks on `@dads-framework/http/live-actions`.
- Added optional `rateLimit?: { enabled?: boolean }` configuration to `BetterAuthIdentityOptions` in `@dads-framework/identity`.
- Added `gatePassed` and `overCeilingCount` fields to `dad doctor --json` output.

### Changed

- Upgraded `fastify` in `@dads-framework/http` to `^5.12.8` (clearing the high-severity Fastify advisory) and updated `createHttpApp` `trustProxy` hop handling to use Fastify 5.12's predicate form.
- Moved `Authorization.can(...)` onto the base `Authorization` class in `@dads-framework/access` so typed permission checks work consistently across Postgres, SQLite, SpiceDB, fake, and recording implementations.
- Lazy-loaded `@better-auth/sso` in `@dads-framework/identity` only when enterprise SSO providers are configured, eliminating startup overhead for standard email/password apps.
- Raised starter `engines.node` to `>=22.22`, updated the minimal starter migration to `installIdentitySchemaV2`, moved starter `DrizzleAuditLogReader` wiring into `assembly/services.ts`, enabled Vitest JSON reporting, and suppressed benign `"use client"` Rollup directive warnings in starter Vite builds.

### Fixed

- Fixed native PostgreSQL `UUID` column-relation comparisons, `UNION` projections, and unused `namespace` parameter binding (`42883`, `UNION types text and uuid`, `22P02`, and `42P18`) across all `@dads-framework/postgres-access` query compilers, verified against live PostgreSQL UUID tables.
- Fixed `definePlugin` zero-generic `Provides` inference and `composeApi` deduplication when the same plugin instance provides both routes and jobs in `@dads-framework/core`.
- Fixed `PdfmakePdfRenderer.render` in `@dads-framework/documents` to merge caller `defaultStyle` instead of overwriting the default `Helvetica` font, and replaced external `@types/pdfmake` leakage with a self-contained structural type.
- Fixed `listMigrationRelativePaths` in `@dads-framework/postgres` to apply each `MigrationSource`'s `files` filter before deduplicating migration IDs across shared roots.
- Fixed `@dads-framework/http` scoped route registration to default `lookups` to `authorization` and fail fast at registration time when required lookups are missing.
- Fixed `dad inspect http-operation` and Doctor route scanners to resolve local and imported `*Operation` contracts as well as `defineRawRoute` and `sseRoute` handlers.
- Fixed `dad doctor` empty-repo git discovery, `--existing` subproject root resolution, single-package `test-count` mapping, and false positives across `rows-sent-whole`, `sequential-authz-writes`, `denial-tests-zero`, `mutations-without-ownership`, `framework-in-core`, `vendor-named-domain`, `provider-chosen-outside-root`, and `kind-inversions`, and allowed top-level `tests/` to import domain root barrels in `dad check boundaries`.

## [0.5.1] - 2026-11-23

### Fixed

- Fixed Postgres catalog introspection in `@dads-framework/postgres/schema-generate` (`dad db generate` / `dad db check`) by casting `pg_catalog` `name` columns inside `ARRAY(...)` subqueries to `::text` so `pg` returns JavaScript string arrays instead of raw `name[]` literals, backed by a live PostgreSQL Testcontainers integration test.
- Fixed `dad doctor` package source discovery (`package-graph`) to scan canonical application layouts (`domains/*`, `assembly`, `workflows`, `integrations`, `libraries/*`, and `kind: "application"`) that do not nest source files under `src/`, so route access and schema checks actually inspect application domain routes.
- Fixed `dad doctor` `kind-inversions` to recognize the `"application"` package kind declared by `create-dads` starter manifests.
- Fixed `dad migrate` to preserve object-literal property keys (such as `moduleAliases` and `tsconfig.json` `paths` entries) while continuing to rewrite import specifiers.

## [0.5.0] - 2026-11-23

### Added

- Added the Postgres-to-Drizzle schema generator (`@dads-framework/postgres/schema-generate`) with catalog introspection, deterministic SHA-256 table fingerprints, branded ID and JSONB `$type<...>()` metadata support, and `checkGeneratedTableFiles` drift verification.
- Added `applicationMigrationWorkspace` to `@dads-framework/postgres/migrations` to discover root `migrations/`, per-domain `domains/*/server/migrations/`, and additional package migration sources under one DAG runner.
- Added `dad db generate`, `dad db check`, `dad db migrate`, and `dad db status` subcommands to `@dads-framework/toolbox`, plus `dad migrate 0.5` support.
- Added the opt-in `cross-domain-foreign-keys` Doctor signal (enabled via `"strictForeignKeys": true` in `dads.project.json`, keeping SQL foreign keys allowed by default) paired with `@dads-framework/core/references`.
- Added branded resource ID type propagation to `resource({ id })`, `.child(...)`, and inline `children` in `@dads-framework/access` (100% backwards-compatible when `id` is omitted).
- Added `buildGrantableCatalog` to `@dads-framework/access/catalog` to build deterministic, grouped, conflict-checked UI capability catalogs from compiled access models.
- Added auth-checked Server-Sent Events channel fan-out (`@dads-framework/http/channels` and `FakeChannelFanOut` in `@dads-framework/http/testing`).
- Added audited live operational actions (`@dads-framework/http/live-actions` and `@dads-framework/postgres/live-actions`) with danger levels, recursive input redaction, permission-gated routes, and Postgres run persistence.

### Changed

- Dogfooded branded IDs (`entityIdSchema`, `mintEntityId`, Drizzle `$type<NoteId>()`, and typed resource IDs) across `apps/kit-workbench`, `create-dads`, and `dad add domain`.

## [0.4.0] - 2026-11-23

### Added

- Added standalone per-operation contracts (`getOperation`, `listOperation`, `postOperation`, `patchOperation`, `putOperation`, `deleteOperation`, `postNoContentOperation`, and `bindOperationPath`) in `@dads-framework/core/contract`, additive `operation` overloads on all seven `@dads-framework/http` verb helpers, and `callApi` / consumer-composed `createApiClient` in `@dads-framework/client`.
- Added typed `can(...)` checks and `PermissionToken` support in `compileFilter` / `resolveFilter` on `PostgresAuthorization` and `SqliteAuthorization`, plus `withReadSnapshot` (`REPEATABLE READ READ ONLY`) in `@dads-framework/postgres-access`.
- Added narrow capability service tokens (`clockService`, `databaseService`, `postgresPoolService`, `jobQueueService`), `overrideService` / `createTestHost` / `startTestHost` in `@dads-framework/core/plugin`, and `startHttpHost` in `@dads-framework/http`.
- Added the `impure-code` Doctor signal banning I/O imports and ambient nondeterminism inside `pure/` modules, extended `dad check boundaries` with `workflows/`, `integrations/`, intra-domain layering, and mixed server/client barrel checks, and added `dad add workflow` and `dad add integration` generators.
- Added [Where Does Code Go?](docs/site/guides/where-code-goes.md) and the end-to-end `workspace → project` [Feature Walkthrough](docs/site/guides/feature-walkthrough.md), and documented the Independent Evolution Principle in [docs/principles.md](docs/principles.md).
- Added `-h` / `--help` usage output to `create-dads`.

### Changed

- Converted optional peer loaders (`pdfmake`, `pdfjs-dist`, `@napi-rs/canvas`, `exceljs`, `resend`, `@react-email/render`, OpenTelemetry packages, and `@sentry/react`) to emit actionable `npm install <pkg>` messages when a peer is missing.
- Dogfooded `startHttpHost`, `domains/notes/pure/`, `*Operation` contracts, `createApiClient`, and narrow capability tokens in `apps/kit-workbench` and the `create-dads` starter.
- Added Rust and npm caching and parallelized `verify-source` in CI release workflows, and auto-capped default local Vitest workers in `scripts/verify-test-step.mjs` to avoid Docker Desktop starvation.

### Fixed

- Updated `dad migrate 0.3` to map all 40 retired `0.2.0` packages (adding the 12 earlier consolidations), skip immutable `*.migration.ts` files by default (with `--include-migrations` opt-in), and report the required `relationshipExpirationMigration` (`expires_at`) database migration when `@dads-framework/postgres-access` is present.
- Updated Doctor's `per-feature-authorization` signal to recognize `0.3+` `*-access` authorization packages alongside `*authorization*`.

## [0.3.0] - 2026-11-20

### Added

- Moved the Dads website source into [`website/`](website/README.md), including branded assets, lockfile, Markdown export pipeline, code-block renderer, agent index generator, and Cloudflare asset configuration. The website package stays private to npm and installs on its own.
- Added runnable starter examples under [`apps/kit-workbench/examples/`](apps/kit-workbench/examples/README.md) with `npm run examples:setup` and a streamlined [Getting Started guide](docs/site/guides/index.md) covering both `--template minimal` and the full starter.
- Added a standalone capability catalog to the [Adopt One Package at a Time guide](docs/site/guides/adopt-standalone.md), covering standalone Postgres ReBAC, TypeScript `.zed` authoring, and incremental adoption.
- Added focused guides for [Permissions in Postgres & SpiceDB](docs/site/guides/permissions.md), [Routes, Contracts & Clients](docs/site/guides/routes-and-contracts.md), and [Multi-API Composition & CI Gates](docs/site/guides/boundaries-and-apis.md).
- Added Architecture Decision Records under [`docs/decisions/`](docs/decisions/README.md) documenting PostgreSQL ReBAC, fail-closed `404` authorization denials, direct Fastify/Zod/Drizzle edges, mechanical boundary ratchets, and tenant/workspace terminology.

### Changed

- Reorganized publishable packages around standalone capabilities, reducing the publishable inventory from 57 packages to 46 (including five `@dads-framework/testing-native-*` platform binaries) and reducing a full starter's first-party dependencies from 51 to 40.
- Consolidated 12 split packages into subpath exports on their owning packages:
  - `@dads-framework/email-sender-core` -> `@dads-framework/email-sender/core` (and `/core/testing`)
  - `@dads-framework/object-storage-core` -> `@dads-framework/object-storage/core` (and `/testing`)
  - `@dads-framework/job-queue-core` -> `@dads-framework/job-queue/core` (plus `/core/testing` and `/core/provider`)
  - `@dads-framework/feature-flags-http` and `@dads-framework/feature-flags-postgres` -> `@dads-framework/feature-flags/http` and `@dads-framework/feature-flags/postgres`
  - `@dads-framework/health` -> `@dads-framework/http/health`
  - `@dads-framework/testing-import-nx` -> `@dads-framework/testing/nx` (with `dad-test-nx` and `dad-test-import-nx` executables in `@dads-framework/testing`)
  - `@dads-framework/telemetry-core` and `@dads-framework/client-telemetry-core` -> `@dads-framework/telemetry/core` and `@dads-framework/client-telemetry/core`
  - `@dads-framework/clock`, `@dads-framework/request-work`, and `@dads-framework/diagnostics` -> `@dads-framework/runtime/clock`, `@dads-framework/runtime/request-work`, and `@dads-framework/runtime/diagnostics`
- Moved third-party provider SDKs (`resend`, `bullmq`, `@aws-sdk/client-s3`, and `@aws-sdk/s3-request-presigner`) to optional peer dependencies so memory and local drivers install without cloud SDKs.
- Reworked starter documentation and walkthroughs to quote live application files and replace long shell transcripts with focused commands and concrete TypeScript snippets.

### Fixed

- Matched versioned native npm archive filenames to their expected Rust target triples across all five supported platforms (`darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, and `win32-x64`) before digest verification during release signing.

## [0.2.0] - 2026-11-20

### Added

- Published the initial public release of Dads Framework npm packages, including `create-dads`, `@dads-framework/toolbox` (`dad`), and `@dads-framework/testing` with five native platform executables.
- Shipped core server, client, and web capabilities: typed HTTP route builders (`@dads-framework/http`), Zod wire contracts (`@dads-framework/contract`), TypeScript ReBAC models (`@dads-framework/access`), transactional PostgreSQL ReBAC (`@dads-framework/postgres-access`), SpiceDB authorization and outbox (`@dads-framework/authorization`), Postgres connection management (`@dads-framework/postgres`), migrations, audit logging, feature flags, object storage, job queues, email sending and templates, telemetry, CSV/PDF/XLSX export helpers, and React UI components (`@dads-framework/ui`).
- Added company identity and tenant administration across `@dads-framework/identity`, `@dads-framework/identity-better-auth`, `@dads-framework/tenants`, and the starter (`apps/kit-workbench`):
  - OIDC and SAML company sign-in by verified domain with optional and required tenant modes, including enforcement during invitation acceptance.
  - SCIM v2 Users and Groups with tenant-bound bearer credentials that revoke linked workspace memberships and authorization tuples in one PostgreSQL transaction on deactivation or deletion.
  - Effective tenant permission inspection (`memberships.permissions`), paginated tenant audit metadata exports, expiring session-bound staff impersonation recording both staff and effective identities, read-only feature flag previews, and separate customer and staff API entrypoints.
- Added `installIdentitySchemaV2` and `installTenantSchemaV2` for fresh application databases, covering Better Auth signing-key columns and SCIM directory tables checked during invitation acceptance, while keeping historical V1 installers and forward migrations intact.
- Added worked setup-and-use examples with observable outputs to every publishable package README, automated snippet typechecking in `npm run check:docs`, six starter walkthroughs, and `jobs: []` support for APIs without background workers.
