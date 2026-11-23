# `@dads-framework/core/contract`

Wire schemas for HTTP pagination, responses, errors, and channel messages. Use the helpers in clients and servers to parse the same payloads.

## Contract

Pagination queries reject undeclared keys, including when extended. Response envelopes and pagination metadata strip undeclared fields. Channel envelopes reject unknown top-level fields. The publishing domain owns the opaque `payload`.

The package also provides namespaced channel names, request ID and API path helpers, standalone per-operation contracts, and UUID v7 entity ID schemas and minting.

## Per-operation contracts

Define one frozen wire contract per endpoint with `getOperation`, `listOperation`, `postOperation`, `patchOperation`, `putOperation`, `deleteOperation`, or `postNoContentOperation`. Each contract pairs a literal mount-relative path template with its Zod `params`, `query`, `body`, `response` (or `item`), `meta`, and `status` schemas, plus validated `bind(...)` and `path(...)` helpers backed by `bindOperationPath`.

The compiler enforces the same verb rules as `@dads-framework/http`: `getOperation` refuses array responses, `listOperation` requires a paginated query (`{ page, perPage }`), `patchOperation` and `putOperation` require `body`, `deleteOperation` and `postNoContentOperation` omit `response`, and `:param` path segments require a matching `params` schema. Share the contract between server routes (`operation: ...`) and `@dads-framework/client` (`callApi` / `createApiClient`).

## Versioned writes

Use `rowVersionSchema` on read and success responses and spread `expectedRowVersionFields` into strict update bodies. `ROW_VERSION_CONFLICT` identifies an authorized stale save. See the [versioned update guide](../../../docs/architecture/stale-save.md).

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

The opaque-ID behavior is covered by the repo’s [`src/lib/type-tests/entity-id.type.test.ts`](../src/contract/lib/type-tests/entity-id.type.test.ts).
In the generated starter, [`domains/notes/server/routes.ts`](../../../apps/kit-workbench/domains/notes/server/routes.ts) and
[`domains/notes/web-client/index.ts`](../../../apps/kit-workbench/domains/notes/web-client/index.ts) share the package’s pagination schema.

## What it refuses to do

This package supplies shared wire schemas. Domains choose their own business fields and the HTTP kit owns request handling.

## Fetch protocols

`FetchHandler` accepts a standard `Request` and returns a `Response`.
A host mounts GET and POST beneath a prefix and carries the handler's status,
headers, and bytes back to the caller. The testing entry point includes an
in-memory Fetch mount and shared conformance cases for binary bodies, multiple
cookies, and a handler's denial and filtered list answers.
