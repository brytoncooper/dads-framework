# Getting Started

Dads is a TypeScript backend framework built around three rules: every HTTP route requires an access rule to compile, permissions run inside your database transactions, and features cannot import each other's internals.

## Choose your starting point

| If you want to...                                                                                                   | Start with                                              |
| :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------ |
| **Start a new TypeScript backend** with auth, workspaces, Postgres permissions, OpenAPI 3.1, and CI checks wired in | Follow the walkthrough below (`npm create dads@latest`) |
| **Decide where a new schema, rule, workflow, integration, or migration belongs**                                    | [Where Does Code Go?](where-code-goes.md)               |
| **Add relationship permissions to an existing Postgres or SQLite app** without a separate auth database             | [Access & Permissions](permissions.md)                  |
| **Look up SDK definitions, options, combinators, and CLI commands**                                                 | [SDK Glossary & Options](sdk-reference.md)              |
| **Migrate SpiceDB into PostgreSQL** or replace hand-written `.zed` files with typed TypeScript                      | [Adopt One Package at a Time](adopt-standalone.md)      |

## Prerequisites

- **Node.js 24** and **npm**
- **Docker** (used by `npm start` to boot local PostgreSQL and the API stack)

## 1. Create a project

Choose the **minimal** template for a clean backend without demo features, or the **example** template for a full runnable app with notes, attachments, exports, and a permissions UI.

Minimal template (clean start):

```sh
npm create dads@latest my-app -- --template minimal
cd my-app
```

Example template (full runnable workbench):

```sh
npm create dads@latest my-app
cd my-app
```

## 2. Start the local stack

Run `npm start` from `my-app`:

```sh
npm start
```

`npm start` boots PostgreSQL in Docker, applies migrations, starts both API entrypoints (`customer` and `staff`), and prints the local URLs.

1. Open the browser URL printed by `npm start` and select **Create an account**.
2. In a second terminal, run `npm run dev:mail` to read the local verification link (no SMTP setup required).
3. Open the verification link, sign in, and create your first workspace.

Useful local commands:

| Command              | What it does                               |
| :------------------- | :----------------------------------------- |
| `npm run dev:status` | Prints the running URLs and ports          |
| `npm run dev:mail`   | Shows local verification and invite emails |
| `npm run dev:down`   | Stops the local Docker stack               |

## 3. Where your code goes

Every Dads app splits code into four areas. `npx dad check boundaries` enforces these import rules in CI so features stay isolated as your team (or your coding agents) adds routes.

| Path                | What lives here                                                                                                                                                                        | Can import                                                  |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| `domains/<name>/`   | Your business features: routes, Zod wire contracts, access rules, database tables, and typed clients. Ships with `domains/tenants/` for built-in auth, users, workspaces, and invites. | Framework packages and `libraries/*`. Never another domain. |
| `apps/<api>/app.ts` | Short manifests that pick which domain plugins and background jobs each HTTP server mounts (`customer/app.ts` for your users, `staff/app.ts` for internal tools).                      | Any `domains/*`, `libraries/*`, and `assembly/*`.           |
| `assembly/`         | Shared server startup, environment config, PostgreSQL pool, composed access model, migrations, and local dev scripts that boot the entrypoints in `apps/`.                             | Any `domains/*`, `apps/*`, and `libraries/*`.               |
| `libraries/`        | Shared runtime types and base entity handles (such as `libraries/app-runtime/index.ts`) that multiple domains need without importing each other.                                       | Framework packages only.                                    |
| `dads.project.json` | The boundary manifest read by `npx dad check boundaries` to verify every import rule.                                                                                                  | Config file.                                                |

> **Why is `assembly/` separate from `apps/`?** `apps/customer/app.ts` and `apps/staff/app.ts` are short manifests that choose which routes exist on each server. `assembly/` is the shared host that boots either entrypoint using the same PostgreSQL pool, auth setup, health checks, and migrations.

For the full one-page placement decision table (including `pure/`, `workflows/`, `integrations/`, and `migrations/`), see [Where Does Code Go?](where-code-goes.md).

## 4. Add your first feature

Generate a relationship-guarded domain and mount it on the `customer` API:

```sh
npx dad add resource products --api customer
```

Pass `--dry-run` first to preview the generated files before writing them.

This creates `domains/products/` with its own contract, access rule, routes, and database table, registers the plugin in `apps/customer/app.ts`, and leaves `apps/staff/app.ts` untouched.

## 5. Verify boundaries, types, and tests

Run the full verification gate from your project root:

```sh
npm run verify
```

`npm run verify` runs four checks in order:

1. `dad check boundaries` confirms no domain imports another domain's internals.
2. TypeScript type-checking verifies every route declares an `access` rule and matching request/response schemas.
3. The web client builds against your updated contracts.
4. Vitest runs your unit and integration tests (with Docker running).

You can also run `npx dad doctor --gate` to check repo-wide rules such as zero `any`, zero unsafe casts, and denial test coverage.

## Next steps

- **See the full placement map (`pure/`, `workflows/`, `integrations/`, `assembly/`):** [Where Does Code Go?](where-code-goes.md)
- **Model and enforce permissions:** [Access & Permissions](permissions.md)
- **Look up SDK definitions and options:** [SDK Glossary & Options](sdk-reference.md)
- **Define endpoints, Zod schemas, and clients:** [Routes, Contracts & Clients](routes-and-contracts.md)
- **Split customer/staff APIs and enforce CI gates:** [Multi-API Composition & CI Gates](boundaries-and-apis.md)
- **Use packages in an existing codebase:** [Adopt One Package at a Time](adopt-standalone.md)
- **Why Dads enforces these rules:** [`DAD.md`](../../../DAD.md) and [`Who let Gary back in?`](../../go-ask-your-other-database.md)
