# Changelog

This file records notable changes to Dads Framework.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
