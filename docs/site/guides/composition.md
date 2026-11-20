# Compose APIs and plugins

The notes fixture gives customers a single-note endpoint and staff a note
count. Each API selects its routes and jobs from plugins. Both compositions
use the same service definitions for a clock and note storage.

<!-- dads:excerpt {"path": "fixtures/plugin-notes/src/apis/customer-api.ts", "language": "ts", "from": "export const customerApi = composeApi(\"customer\", {", "through": "});"} -->

<!-- dads:excerpt {"path": "fixtures/plugin-notes/src/apis/staff-api.ts", "language": "ts", "from": "export const staffApi = composeApi(\"staff\", {", "through": "});"} -->

## Try the same request on both hosts

From the framework checkout with dependencies installed, build the workspace
and run the API selection test. It starts two in-process HTTP hosts, writes
a note to the customer store, and uses a test identity with both the note's
`author` relationship and the dashboard's `operator` relationship.

```sh
npm run build
npm test -w @dads-fixture/plugin-notes -- api-selection.test.ts
```

<!-- dads:excerpt {"path": "fixtures/plugin-notes/src/apis/api-selection.test.ts", "language": "ts", "from": "    const request = {", "through": "    expect(staff.jobs.map((job) => job.name)).toEqual([\"notes.count\"]);"} -->

For that identity, customer serves `GET /notes/note-one` with
`{"data":{"id":"note-one","text":"one note"}}`. Staff serves
`GET /staff/notes/count` with a `data.count` integer for its own store.
Each host returns **404** for the other host's path. Staff also returns
**404** for its own count route when the caller lacks the operator
relationship. Route selection and the route's permission check both matter.

To add a surface, export its route contribution from the domain plugin and
select it in the intended API's `routes` array. Put background jobs in a
separate contribution so each host can select them independently. Test the
request on both hosts with the same authorized identity, then change the
identity on the host that serves the route to exercise the permission check.
