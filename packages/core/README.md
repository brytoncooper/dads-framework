# `@dads-framework/core`

Zero-database foundation primitives for Dads applications: shared HTTP wire schemas (`/contract`), structured domain errors (`/errors`), clock/request-work/diagnostics runtime (`/runtime/*`), typed plugin composition (`/plugin`), in-process event bus (`/event-bus`), audit actor context (`/audit-actor`), and cross-domain reference guards (`/references`).

## Contract

Pagination queries reject undeclared keys, including when extended. Response envelopes and pagination metadata strip undeclared fields. Channel envelopes reject unknown top-level fields. The publishing domain owns the opaque `payload`.

The package also provides namespaced channel names, request ID and API path helpers, and UUID v7 entity ID schemas and minting.

## Versioned writes

Use `rowVersionSchema` on read and success responses and spread `expectedRowVersionFields` into strict update bodies. `ROW_VERSION_CONFLICT` identifies an authorized stale save. See the [versioned update guide](../../docs/architecture/stale-save.md).

## Try it

Install the shared schemas.

```sh
npm install @dads-framework/core
```

Save as `account-id.mts` and run `node account-id.mts` with Node.js 22.18 or newer.

<!-- dads:check-example -->

```ts
import { opaqueIdSchema } from "@dads-framework/core/contract";

const accountId = opaqueIdSchema("AccountId", "Account identifier.");
console.log(accountId.parse("account-1"));
console.log(accountId.safeParse(42).success);
```

The script prints `account-1` and then `false`. The schema accepts the
wire string and rejects a numeric ID.

The opaque-ID behavior is covered by the repo’s [`src/contract/lib/type-tests/entity-id.type.test.ts`](src/contract/lib/type-tests/entity-id.type.test.ts).
In the generated starter, [`domains/notes/server/routes.ts`](../../apps/kit-workbench/domains/notes/server/routes.ts) and
[`domains/notes/web-client/index.ts`](../../apps/kit-workbench/domains/notes/web-client/index.ts) share the package’s pagination schema.

## What it refuses to do

This package supplies shared wire schemas. Domains choose their own business fields and the HTTP kit owns request handling.

## Fetch protocols

`FetchHandler` accepts a standard `Request` and returns a `Response`.
A host mounts GET and POST beneath a prefix and carries the handler's status,
headers, and bytes back to the caller. The testing entry point includes an
in-memory Fetch mount and shared conformance cases for binary bodies, multiple
cookies, and a handler's denial and filtered list answers.
