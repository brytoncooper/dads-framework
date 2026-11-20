---
name: extend-http-framework
description: Change Dads HTTP behavior while preserving transport, application, and client boundaries.
---

# Extend the HTTP framework

1. Name the transport behavior changing and which routes depend on it.
2. Keep shared wire schemas and route descriptors in
   `@dads-framework/contract`. Put HTTP parsing, enforcement, request lifecycle,
   and transport translation in `@dads-framework/http`.
3. Pass parsed values and typed access facts into handlers. Keep engine
   requests and replies inside the HTTP kit.
4. Prove behavior through `@dads-framework/http/testing`. Add a listening-server
   test when the change depends on socket behavior.
5. Typecheck the dependent app and keep engine types out of its contracts.
6. Run the focused checks returned by `dad orient`.

Resolve cross-cutting behavior from named route or application declarations.
