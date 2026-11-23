# HTTP hosting

The [HTTP kit](../packages/server/http/README.md) registers typed routes on the
application's HTTP app. Route cards declare the method, mount-relative path,
request and response schemas, access requirements, and handler. The server
parses the request and enforces access before the handler starts.

## Composition

Create one application with `createHttpApp` and register each surface's
routes with its subject resolver and authorization ports. Applications that
mount multiple APIs can use [`composeApi`](../packages/core/README.md)
to check collisions before mounting. Use the same cards to build OpenAPI
with `buildOpenApiDocument`.

The host owns CORS origins, body size, timeouts, request IDs, access refusals,
and error envelopes. A route can declare raw, SSE, or WebSocket transport
where its contract calls for it. Configure trusted proxy hops at the
composition root.

## Test an HTTP route

`buildTestApp` under `@dads-framework/http/testing` runs registered routes
through the real HTTP pipeline without a listening socket. It defaults to
denying protected requests. A test can supply a seeded authorization port
and send a subject with `TEST_SUBJECT_HEADER`.

```ts
import { buildTestApp } from "@dads-framework/http/testing";

const app = await buildTestApp({ routes });
try {
  const response = await app.inject({ method: "GET", url: "/status" });
  console.log(response.statusCode);
} finally {
  await app.close();
}
```

Here `routes` is the application's list of route cards. Supply a subject
and seeded authorization port when testing a protected route. Prove the same
request succeeds with its relationship and is refused without it, then close
the test host in both cases.

Use a listening server when the test is about network behavior. The
[Workbench](../apps/workbench/README.md) exercises a listening server,
an authenticated request, and database-backed access. The
[kit starter](../apps/kit-workbench/assembly/start-app.ts) shows how a host
mounts the identity protocol and registers the selected typed API beneath
`/api`.
