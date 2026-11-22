# Dads

**A TypeScript backend framework with firm boundaries.**

Dads builds TypeScript backends around four primitives: typed HTTP contracts, transactional relationship permissions in PostgreSQL, explicit multi-API composition, and enforced domain boundaries. You declare each route's parameters, body, response, access rule, and rate limits in one place. Dads validates requests, generates OpenAPI specs, and powers typed clients from those contracts while your business logic stays plain TypeScript.

## Start a new app

Ensure you have Node 24, npm, and Docker with Compose v2 running. Run the creator from the parent directory for your project:

```sh
npm create dads@latest my-app
```

The creator installs dependencies, starts PostgreSQL, applies migrations, and prints URLs for the web app and both APIs. Open the browser URL to reach the sign-in screen. Follow [Getting Started](./docs/site/guides/index.md) to verify a local email account and start building. Inside `my-app`, run `npm start` to restart the stack and `npm run dev:down` to stop it.

To scaffold a clean app with the full Dads structure, tenant auth, and zero demo domains, pass `--template minimal`:

```sh
npm create dads@latest my-app -- --template minimal
```

For an existing codebase, read [Adopt One Package at a Time](./docs/site/guides/adopt-standalone.md). Browse the [package examples](https://dadsframework.dev/docs/packages) for install commands, working snippets, and expected output.

You choose which plugins and background jobs each API entrypoint mounts, sharing domain code through public entrypoints:

```text
apps/
  customer/app.ts
  staff/app.ts
  web/
domains/
  notes/contract/
  notes/access/
  notes/server/
libraries/
assembly/
ci/
```

## Run the Workbench

Run the repository's reference task API from source to inspect Dads without scaffolding a new app. With Node 24 and Docker Compose running, execute these commands from the repository root:

```sh
npm ci
npm run workbench:dev
```

The launcher starts an isolated PostgreSQL instance, applies the schema, and prints the API and OpenAPI URLs. Workspace members can discover tasks, claim them, and read artifacts and activity. Revoking membership removes that access in the same PostgreSQL transaction.

Run `npm run workbench:stop` when you finish. Read the [Workbench guide](./apps/workbench/README.md) for local demo identities and route ownership.

## Work with a Dads project

Every generated starter installs the Toolbox CLI as a development dependency. Run these commands from `my-app`:

```sh
npx dad --help
npx dad orient domains/notes/server/routes.ts --json
npx dad doctor
npx dad test:recommend --changed --json
npx dad verify --changed --json
```

Explore the framework guides and references:

- [Getting Started](./docs/site/guides/index.md): Create a project, local stack commands, and where your code goes.
- [Access & Permissions](./docs/site/guides/permissions.md): Top-down relationship models, transactional checks in Postgres and SQLite, connected migrations, and SpiceDB cutover.
- [SDK Glossary & Options](./docs/site/guides/sdk-reference.md): Core definitions (`actor`, `resource`, `children`, `inherit`, `compileAccess`, `createAccessClient`), combinators, adapter options, and CLI commands.
- [Routes, Contracts & Clients](./docs/site/guides/routes-and-contracts.md): Zod wire schemas, fail-closed route guards, OpenAPI 3.1, and typed clients.
- [Multi-API Composition & CI Gates](./docs/site/guides/boundaries-and-apis.md): Customer/staff entrypoints, boundary checks, Doctor gates, and production deployment.
- [Adopt One Package at a Time](./docs/site/guides/adopt-standalone.md): Drizzle-free Postgres ReBAC, standalone SQLite ReBAC, SpiceDB to PostgreSQL cutover, and incremental adoption.
- [Generator guide](./docs/generators.md): All nine `dad add` scaffolding commands.
- [Domain boundaries](./docs/domain-boundaries.md): Public entrypoints, import checks, and composition rules.
- [Toolbox command reference](./packages/foundation/toolbox/README.md): CLI flags and JSON output schemas.
- [Plugin composition](./packages/foundation/plugin/README.md): Selective customer and staff API entrypoints.
- [Doctor and enforcement](./docs/doctor.md): Static health checks and repair guides.
- [CI workflow templates](./ci/README.md): Portable verification scripts for CI providers.
- [Architecture decisions](./docs/decisions/README.md): Trade-offs behind PostgreSQL ReBAC, fail-closed denials, direct edges, and boundary ratchets.
- [Changelog](./CHANGELOG.md): Release history, consolidated package paths, and notable changes.
- [Contributing](./CONTRIBUTING.md): Verification workflow for framework changes.

Read [Dad](./DAD.md) and [Who let Gary back in?](./docs/go-ask-your-other-database.md) for the stories behind the architecture.

## License and notices

Dads is licensed under [MIT](./LICENSE.md). See [Third-party notices](./THIRD_PARTY_NOTICES.md) for included upstream code and licenses, and the [website README](./website/README.md) for documentation site source and build instructions.
