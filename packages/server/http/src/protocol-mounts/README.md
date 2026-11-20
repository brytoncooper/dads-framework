# `@dads-framework/http/protocol-mounts`

Mount an existing Fetch protocol handler without translating its routes into
Dads route cards. The API composition root owns the mount prefix. Domains
define MCP tools with the main [HTTP package](../../README.md). Composition
uses `createMcpEndpoint` to serve those tools over MCP.

## Try it

```ts
import { mountFetchHandler } from "@dads-framework/http/protocol-mounts";

await app.register(
  mountFetchHandler({
    handler: () => Promise.resolve(new Response("Ready")),
  }),
  { prefix: "/example" },
);
```

Send a GET or POST request to `/example/status` on the running app to receive `Ready`. Keep the
prefix literal so the host can inspect the mount. Use the `methods` option for
protocols that need additional verbs. Explicit method lists also control whether
HEAD is forwarded.

## Why this is its own project, nested inside the kit it belongs to

The separate export lets application route code use the HTTP contract without
loading protocol handlers. The bridge converts incoming requests to WHATWG
`Request` objects and forwards the handler's `Response`. The MCP endpoint owns
JSON-RPC and its authorization metadata.
