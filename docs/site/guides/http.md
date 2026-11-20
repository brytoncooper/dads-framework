# HTTP and contracts

Start with the request a client needs to make. In the starter, the browser
creates a note with `POST /api/tenants/:tenantId/notes`. The path identifies
the workspace, the JSON body contains the note text, and the response carries
the created note. The route declares each boundary before it calls storage.
[Try the request from the starter](../../../apps/kit-workbench/README.md#call-the-customer-api-from-the-command-line)

## Read the route from the outside in

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/server/routes.ts", "language": "ts", "from": "    postRoute({", "through": "      response: note,"} -->

- `inTenant` parses the path parameter. `noteInput` describes the accepted
  JSON body. `note` describes the success payload. Keep these schemas in the
  domain contract so the web client can consume them too.
  [Notes contract](../../../apps/kit-workbench/domains/notes/contract/wire.ts)
- The route declares its access requirement alongside its input and output.
  The handler receives parsed inputs and uses the authorized tenant ID in
  the insert. The HTTP kit owns request parsing, response validation, and
  OpenAPI generation.
  [Notes routes](../../../apps/kit-workbench/domains/notes/server/routes.ts) ·
  [HTTP kit](../../../packages/server/http/README.md)
- The list route uses the same tenant path but has an item schema and
  pagination. Check the response shape at the API boundary when you add a
  field or change a status.
  [Contract package](../../../packages/contract/README.md)

When you change a route, compare its emitted OpenAPI surface and update the
client calls that consume it. Exercise the success response and a refused
request through the real host. If a mounted vendor handler owns its own
protocol, use the host's protocol mounting seam to keep that ownership
explicit.
[Guarded resource walkthrough](./guarded-resource.md) ·
[HTTP hosting model](../../http-hosting.md)
