# Add a guarded resource

Start with a resource that belongs to a workspace, such as a product catalog.
A signed-in workspace member should be able to read it. A caller who belongs
to a different workspace should get a 404, even with the workspace ID.

## Generate a resource

From the root of an installed starter:

1. Run `npx dad add resource products --api staff --dry-run --json` and review the files and API entrypoint in the plan.
2. Run `npx dad add resource products --api staff` to apply the change.

The scaffold adds list, read, and update routes, plus the access model,
database migration, and web-client exports. Install dependencies if the
manifest changed, apply the migration, and run `npm run verify`. Your app
supplies the product creation workflow and chooses where the generated
components appear in the browser. [Generator guide](../../generators.md)

## Follow a working request

In the starter, sign in, create a workspace, and add a note. The notes API
takes the workspace's tenant ID from the URL. Its access declaration selects
the tenant view permission, and the route uses that same tenant ID in its
database predicate. The create handler rechecks permission inside the
transaction that inserts the note.
[Start the kit](../../../apps/kit-workbench/README.md) ·
[Notes access](../../../apps/kit-workbench/domains/notes/access/index.ts) ·
[Notes routes](../../../apps/kit-workbench/domains/notes/server/routes.ts)

Start your resource proof with a successful read. Then try reading without
a session and as a signed-in caller from another workspace. Try updating as
a caller without management permission. Write the denial assertions
through the same API entry point your clients use. For lists, seed rows in
both workspaces and assert which IDs come back.
[Starter integration proof](../../../apps/kit-workbench/tests/starter.integration.test.ts)

For a smaller example, the notes plugin fixture reads one note through its
author relationship and refuses a request by an unrelated caller. Its
customer and staff surfaces have their own composition tests. From the
framework checkout, run `npm run build` and
`npm test -w @dads-fixture/plugin-notes`.
[Note fixture routes](../../../fixtures/plugin-notes/src/notes-routes.ts) ·
[Customer API](../../../fixtures/plugin-notes/src/apis/customer-api.ts) ·
[Staff API](../../../fixtures/plugin-notes/src/apis/staff-api.ts) ·
[Note fixture test](../../../fixtures/plugin-notes/src/notes-plugin.test.ts) ·
[API selection test](../../../fixtures/plugin-notes/src/apis/api-selection.test.ts)

Before editing an existing route, run `dad orient <path> --json` to find its
owner, allowed dependencies, and suggested verification.
