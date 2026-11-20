# HTTP and contracts

Define what crosses the wire before wiring the handler. Use the
[contract package](../../../packages/contract/README.md) for schemas at the
boundary and [the HTTP kit](../../../packages/server/http/README.md) for route
registration, response validation, errors, and OpenAPI.

For a new route, follow [the guarded resource walkthrough](./guarded-resource.md).
Review the path, query, success envelope, and response status in the contract.
When a route changes, update its consumers and compare the emitted API surface
with the previous version. Read the [HTTP hosting model](../../http-hosting.md)
for the boundary between your contracts and transport.
