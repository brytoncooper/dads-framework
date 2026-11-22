# ADR-0003: Use Fastify, Zod, and Drizzle Directly at Transport and Storage Edges

## Status

Accepted

## Date

2026-11-20

## Context

Principle 10 in [Dads guiding principles](../principles.md) states that abstractions must earn their existence by naming the change they absorb. Frameworks that hide their HTTP server, schema validator, and SQL query builder behind proprietary wrappers trade away library type inference, double the documentation surface, and force developers to debug through an extra translation layer that absorbs little real replacement churn.

At the same time, Dads must still prevent transport plumbing from leaking into domain handlers, guarantee access-before-validation and uniform error envelopes on every route, and manage shared PostgreSQL pools and transactions across an application.

## Decision

Adopt Fastify, Zod, and Drizzle at transport, contract, and PostgreSQL storage edges rather than wrapping them behind framework-specific DSLs.

1. **Fastify at the HTTP edge (`@dads-framework/http`):** `createHttpApp`, `registerRoutes`, `mountFetchHandler`, and `buildTestApp` run on Fastify 5. Tests call Fastify's in-process `app.inject()` without opening a port, and streams use `defineRawRoute` when handlers need raw `request`/`reply` access. Domain route handlers stay free of `fastify` imports because typed verb builders (`getRoute`, `listRoute`, `postRoute`, `patchRoute`, `putRoute`, `deleteRoute`) pass `RouteHandlerContext` containing parsed inputs, `subject`, `requestId`, `locale`, and a structural `RouteLogger`.
2. **Zod across wire contracts (`@dads-framework/contract`, `@dads-framework/http`, `@dads-framework/access`):** Applications declare entity IDs, pagination queries, route `params`/`query`/`body`/`response` schemas, and entity handles with Zod (`z.object`, `z.strictObject`, `z.uuid`, `z.input`, `z.output`). One Zod definition drives server request parsing, server response drift checks, OpenAPI generation (`buildOpenApiDocument`), and browser response parsing (`@dads-framework/client-request-transport`).
3. **Drizzle and `pg` at the Postgres edge (`@dads-framework/postgres`):** `createPostgresConnection` exposes the native `pg` pool alongside the schema-generic Drizzle instance (`@dads-framework/postgres/drizzle`). Domain persistence modules write standard Drizzle queries (`eq`, `count`, `tx.insert`, `updateAtRowVersion`) and pass Drizzle transactions to `withProtectedPostgresTransaction` and `PostgresAuthorization.inDrizzleTransaction(tx)`.
4. **Quarantine real swap seams:** Capabilities that change across environments or customers stay behind application-owned ports (`@dads-framework/object-storage`, `@dads-framework/email-sender`, `@dads-framework/job-queue`, `@dads-framework/access/runtime`, and `@dads-framework/identity`).

## Alternatives considered

### Wrap HTTP, schema validation, and SQL queries behind custom Dads interfaces

- **Pros:** Lets an application replace Fastify with Hono, Zod with Valibot, or Drizzle with Prisma behind framework adapters without editing edge modules.
- **Cons:** Strips rich static inference (`z.input`/`z.output`, Drizzle table column types, Fastify lifecycle hooks), creates a lowest-common-denominator API, and adds permanent wrapper maintenance for swaps that seldom happen inside a running system.
- **Rejected:** Wrapping foundational primitives violates the rule that every abstraction must absorb a realistic change.

### Skip `@dads-framework/http` and `@dads-framework/postgres` and call libraries in every domain

- **Pros:** Removes the route builder and connection helper packages altogether.
- **Cons:** Calling `app.get()` in domains bypasses compile-time `access` enforcement, access-before-validation ordering, response envelopes, handler deadlines (`handlerTimeoutMs`), and OpenAPI parity. Creating ad-hoc `pg.Pool` instances fragments pool sizing, shutdown hooks, and audit attribution.
- **Rejected:** `@dads-framework/http` and `@dads-framework/postgres` absorb real cross-cutting policy while leaving Fastify, Zod, and Drizzle visible where developers author routes, schemas, and queries.

## Consequences

- Developers and coding agents use standard Fastify, Zod, and Drizzle APIs and documentation rather than learning a custom schema language or query DSL.
- Server routes, OpenAPI documents, and browser clients share identical Zod contracts without code-generation glue between incompatible type systems.
- Drizzle transactions compose with `@dads-framework/postgres-access` so business inserts and relationship tuple changes share one `tx` handle.
- Breaking major upgrades in Fastify, Zod, or Drizzle touch the edge modules and contract files that import them. Blast radius stays contained to contract and persistence files because cross-domain contracts and domain policies remain decoupled from storage tables.

## References

- [Dads guiding principles](../principles.md)
- [Validation at the contract boundary](../validation.md)
- [HTTP hosting](../http-hosting.md)
- [`@dads-framework/http` README](../../packages/server/http/README.md)
- [`@dads-framework/contract` README](../../packages/contract/README.md)
- [`@dads-framework/postgres` README](../../packages/server/postgres/README.md)
- [Starter Notes routes](../../apps/kit-workbench/domains/notes/server/routes.ts)
