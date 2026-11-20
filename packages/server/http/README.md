# @dads-framework/http — HTTP routes

The one way routes exist. You should be able to ship an endpoint from this
page alone — no Fastify knowledge required (Fastify is an implementation
detail inside this lib; importing it anywhere else is banned).

## Define a route — the verb IS the function

```ts
import { permissionToken } from "@dads-framework/access";
import { getRoute, requires, fromParam } from "@dads-framework/http";
import { z } from "zod";

// In a real route this comes from the owning domain's contract lib.
const organizationSchema = z.object({ id: z.uuid(), name: z.string() });

export const getOrganization = getRoute({
  route: { method: "GET", template: "/organizations/:id" },
  summary: "Get an organization",
  access: requires(
    permissionToken("organizations/organization", "view"),
    fromParam("id"),
  ),
  params: z.object({ id: z.uuid() }),
  response: organizationSchema, // the DATA shape from the contract lib
  handler: ({ params }) => ({ id: params.id, name: "Example Organization" }),
});
```

One function per verb, each carrying its own compile rules:

| Verb                      | Rules the compiler enforces                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRoute`                | A single read: no `body` key, no ARRAY responses (collections are `listRoute`); always 200                                                                           |
| `listRoute`               | THE collection verb: query must extend `paginationQuerySchema`, handler returns `{ items, total }`, the kit builds `{ data, meta }` — pagination is compile-enforced |
| `postRoute`               | 201 by default (`status: 200` for command-style posts)                                                                                                               |
| `postNoContentRoute`      | A guarded POST that reports and learns nothing back: no response schema, handler returns nothing, 204                                                                |
| `patchRoute` / `putRoute` | `body` is REQUIRED; no query/meta/status; always 200                                                                                                                 |
| `deleteRoute`             | THE no-content shape — no response schema, handler returns nothing, 204; optional request `body` when path params alone are not enough                               |

Handlers may be sync or async — the return type is `X | Promise<X>` and the
kit awaits either, so you only write `async` when you `await` inside (and
forgetting it there is a compile error, not a runtime bug).

## Groups — the only door to registration

Verbs return **blueprints**; `registerRoutes` accepts only grouped routes,
so forgetting the group is a compile error:

```ts
export function createOrganizationsRoutes(deps: Deps): HttpRoute[] {
  return routeGroup("Organizations", [
    listRoute({ ... }),
    getRoute({ ... }),
  ]);
}
```

The tag is stamped once per group (it is not a route field). Groups compose
— a domain owning two tags returns `[...groupA, ...groupB]`.

## Capabilities — named fields, never middleware

Cross-cutting behavior is declared data resolved through a three-rung
ladder — **route field > group capabilities > app default**
(`registerRoutes({ capabilities })`) — so "what applies to this route" is
answerable by reading at most three named places. There are no middleware
arrays and never will be; true universals live in the kit pipeline itself.

```ts
routeGroup("Auth", { rateLimit: { perMinute: 30 } }, [
  postRoute({ ..., capabilities: { rateLimit: { perMinute: 5 } } }), // route wins
  getRoute({ ... }), // inherits the group's 30/min
]);
```

First shipped capability: `rateLimit` (per-caller fixed window, per
replica; 429 + `retry-after` once spent, budget consumed only AFTER access
so denied callers learn nothing). `machineCredential: "<name>"` (route or
group only; the app rung throws) makes the route resolve its caller only
through `registerRoutes({ machineCredentials })[name]` instead of sessions;
a missing resolver or a public route throws `HttpWiringError` at registration.
Capabilities grow by need — each lands with an engine and tests in the kit.

The kit does the rest: parses `params`/`query`/`body` (bad input → 400 with
field issues), runs your handler, parses the return through `response`
(drift → loud 500), and wraps it in the `{ data }` envelope. You never
touch statuses, envelopes, or serialization.

**The compiler is the reviewer.** These do not compile: a route without
`access`; a GET with a body; a PATCH without one; a `params` schema that
doesn't cover the path's `:params`; a handler return that doesn't satisfy
`response`; touching `subject` as non-null on a public route.

## The access vocabulary — all of it

| Constructor                                                                      | Meaning                                                                                      | Handler's `subject`  |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------- |
| `requires(token, fromParam("id"))`                                               | Relationship check on the resource; denied → **404** (existence never leaks), anon 401       | `SubjectRef`         |
| `… fromBody("organizationId")` / `fromQuery("workspaceId")` / `fromFixed("app")` | Same check; id from body field, query param, or a compile-time constant (singleton platform) | `SubjectRef`         |
| `requireSession()`                                                               | Authenticated caller; the mutation/query owns authorization (lists/creates)                  | `SubjectRef`         |
| `publicAccess()`                                                                 | Explicitly unauthenticated (health, auth)                                                    | `SubjectRef \| null` |

## Variants

- **Streams (SSE, downloads, multipart)**: `defineRawRoute({ ..., method, openapi,
handler: ({ request, reply }) => ... })` — the ONE escape hatch. Same
  `access` requirement and error envelope; no handler deadline (streams own
  their lifetime); its hand-written `openapi` operation lands in the
  artifact marked `x-raw-route: true`. The bar for using it: the kit can't
  express what you need AND growing the kit was considered first — never
  import `fastify` in a domain.

## Errors

Throw typed `DomainError`s from domain code (`notFound`, `conflict`,
`validation`, `forbidden` from `@dads-framework/errors`); the kit maps kinds to
statuses in one place. Kit-produced failures: request validation → 400,
response drift / wiring bugs → masked 500 (logged loud), handler past its
deadline → 503 `HANDLER_TIMEOUT`. Unknown errors are always masked — no
internals in bodies, correlation id included.

## Process discipline (defaults you can raise, never disable)

`createHttpApp` sets: body limit 1 MiB, request/connection/keep-alive
timeouts, `trustProxy` as a hop count (`trustedProxyHops`, default 0 — never
trust-all XFF; CloudFront + ALB is 2 so `request.ip` is the viewer),
request-id correlation (inbound `x-request-id` honored, always
echoed), credential-redacting pino, CORS for trusted origins. Every typed
route runs under a hard handler deadline — a hung handler answers 503 and
frees its socket; its orphaned promise drains into the log.

Given a `requestLog` lookup and an `apiRelease` stamp, `createHttpApp` also
captures one `request_log` row per answer from an `onResponse` hook — routes,
404s, the 426 gate, 429s, error-handler responses, and protocol mounts alike.
Nothing per route: it is a pipeline universal, successful reads are skipped,
and capture can never change a response. What is stored, and for how long:
observability.

## Testing

```ts
import {
  buildTestApp,
  dataBodyOf,
  errorBodyOf,
} from "@dads-framework/http/testing";

const app = await buildTestApp({
  routes: routeGroup("Organizations", [getOrganization]),
  authorization: seededFake,
});
const res = await app.inject({
  method: "GET",
  url: "/organizations/xyz",
  headers: { "x-test-subject": "u1" },
});
expect(dataBodyOf(res, organizationSchema).id).toBe("xyz");
```

`buildTestApp` never opens a port (`listen` does not exist on it — pinned
by a type test). Default subject = `x-test-subject` header; default
authorization denies everything until you pass a seeded `FakeAuthorization`.
Parse bodies with `dataBodyOf`/`listBodyOf`/`errorBodyOf` (or `bodyOf` for
an arbitrary schema) — `res.json()` is `any` and defeats the type walls.

## Folder story

- `lib/route/` — authoring: one file per verb, `route-group`, `access`, `capabilities`, `define-raw-route`, `sse-route`, and `route-definition` (parse → handler → parse).
- `lib/create-http-app.ts` — builds the Fastify instance (logger, CORS, timeouts, request-id, trustedProxyHops).
- `lib/request-pipeline/` — `register-routes` (enforce → run under deadline → envelope), `enforce-access`, `with-deadline`, `error-handler`, `envelope`, `rate-limit`, `request-id`.
- `lib/openapi/` — the generated document. The kit knows how to convert a route table, never which domains exist: nothing here imports a domain contract lib (`@dads-framework/contract` is the kit's own vocabulary). The parity golden test that pins the generated document against the committed artifact needs real domain schemas, so it lives with the composition root that already knows them.
- `lib/request-log/` — the captured row: `request-record` (pure builder plus the header allowlist), `request-outcome` (what the pipeline learned and the response no longer shows), `capture-request-record` (the `onResponse` hook), `request-log-sink` (the seam `@dads-framework/audit` implements).
- `lib/http-errors.ts` — typed failures this library produces while running a route.
- `src/testing/` — `buildTestApp` + typed inject-response helpers.

## Protocol mounts — someone else's wire spec

A surface that implements another party's protocol (Better Auth's
`/api/auth/*`, the remote MCP endpoint) is not a route: it is a fetch-style
handler mounted whole. That code is its own Nx project, `api-http-protocol-mount`
in [`protocol-mount/`](./src/protocol-mounts/README.md), imported as
`@dads-framework/http/protocol-mounts`.
`mountFetchHandler` is the one bridge for that — every content type arrives as
raw bytes, the request crosses to a WHATWG `Request` whose clones never share
a stream (`to-web-request.ts`, the Node 22 undici clone trap), and the
handler's `Response` is copied back status, headers and body. Register it with
a literal prefix so the `protocol-mount boundary` wall can read it; an
`extraSetCookies` hook appends cookies to one answer, which is how an
API can clear an authorization-consistency cookie on sign-out.

```ts
await app.register(mountFetchHandler(auth), { prefix: "/api/auth" });
```

## Compose authorization for lists

Use `requires`, `requiresVisible`, or `requiresScoped` from
`@dads-framework/http` with an access permission token. Pass the app's
`accessModel` as `registerRoutes`'s `accessModel` option for visibility and
scoped routes. Registration refuses an omitted model or a missing list
resource definition. Record routes use `requiresScoped` with scope bindings. Tests can pass the same
model and a fake lookup port to `buildTestApp`.

Set `currentTraceId` and `requestTrace` on `createHttpApp` to correlate request records and annotate the active request span. The observer receives the request ID and the audit actor kind.

## What it refuses to do

Application code supplies identity, access policies, and business handlers. The HTTP kit enforces the declared route boundary and owns transport.

A public POST that only appends internal telemetry can declare
`resourcePolicy: { kind: "resource-free", purpose: "append-only-telemetry" }`.
Use status `200` and a bounded body schema. Return an acknowledgement of the
report. The telemetry entries remain internal to the application.

`mountFetchHandler` implements the shared `FetchHandler` protocol boundary.
Its transport conformance runs over a real Fastify socket and against the
contract package's independent in-memory Fetch host. The shared proof covers
GET and POST beneath a prefix. Fastify-specific hooks and limits have their own
tests.
