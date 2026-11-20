---
name: add-http-operation
description: Add a Dads HTTP operation with its complete contract, access, resource policy, proof, OpenAPI, and client surface.
---

# Add an HTTP operation

1. Run `npx dad orient <route-path> --json` to locate the owning application
   contract and handler. The HTTP kit owns request parsing and transport.
2. Define the request and response schemas separately. Use strict request
   objects and choose the outgoing fields explicitly.
3. Add a verb card to the application's route group. Set the route's method,
   template and summary, then declare its access requirements and schemas.
4. Use the collection route helper for lists and the applicable transport
   helper for raw bytes, event streams, or WebSockets.
5. Prove parsing, the response, and OpenAPI output. For protected routes,
   prove denial without the relationship and access when granted.
6. Run `npx dad test:recommend --changed --json` and its focused commands.

Handlers receive parsed application values and call the owning operation.
