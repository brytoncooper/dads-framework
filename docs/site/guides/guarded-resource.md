# Add a guarded resource

To scaffold a protected resource in a kit starter, run
`dad add resource products --api staff`. See the
[generator guide](../../generators.md) for dependency installation, migration,
and web composition.

To see how the contract, relationship, and API selection fit together, read
the note fixture. It serves one note to its author and returns HTTP 404 for
an unrelated caller.

1. Declare the resource kind and its relationship in the
   [note access model](../../../fixtures/plugin-notes/src/notes-access.ts).
   The permission derives from the author relationship.
2. In the [route definition](../../../fixtures/plugin-notes/src/notes-routes.ts),
   parse the resource ID from the path, use the access model's permission
   handle, and give the success body a schema.
3. Register the route in the API that needs it. The
   [customer API](../../../fixtures/plugin-notes/src/apis/customer-api.ts)
   selects its own route surface and no jobs. The
   [staff API](../../../fixtures/plugin-notes/src/apis/staff-api.ts) selects
   its own routes and the staff jobs. They share the notes storage service.
   The [API isolation test](../../../fixtures/plugin-notes/src/apis/api-selection.test.ts)
   proves that even a staff identity cannot reach a staff-only route through
   the customer API.
4. Run [the note fixture test](../../../fixtures/plugin-notes/src/notes-plugin.test.ts).
   It injects two requests through the real HTTP kit and asserts both
   successful access and refusal.

From this workspace, run `npm run build` and
`npm test -w @dads-fixture/plugin-notes` to execute the fixture.

Use `dad orient <path> --json` before editing an existing route to locate its
owner, permitted dependencies, and suggested verification.
