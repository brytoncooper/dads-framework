# `@dads-framework/http/protocol-mounts`

The fetch-handler bridge (`mountFetchHandler`, `toWebRequest`) and the remote
MCP endpoint (`createMcpEndpoint`, its JSON-RPC methods and RFC 9728 metadata).
Only composition roots mount these — an application's API wiring and its
identity layer's auth mount. The MCP tool seam domains author against
(`defineMcpTool`, `McpToolSet`) stays in the main [`@dads-framework/http`](../../README.md)
barrel, and this project reaches the kit only through that barrel.

## Why this is its own project, nested inside the kit it belongs to

Nx computes `affected` per **project**, so while these files sat in `api-http`,
every MCP endpoint change re-ran all 65 projects that define an HTTP route (45
of them with integration suites), none of which mounts a protocol. As its own
node, a change here reaches only the roots that mount one and what depends on
them.

The alias was `@dads-framework/http/protocol-mount` (singular) while it pointed
into `api-http`. It got a new name rather than a new target because Nx caches
each file's resolved imports and only re-reads a file when the file changes —
it never notices an alias pointing somewhere else (it reads the `paths` in
`tsconfig.base.json` itself, and ours live in `tsconfig.paths.json` behind
`extends`). Renaming the alias changes every importer, so every cache re-reads
it.
