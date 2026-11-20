# Compose APIs and plugins

Give each API an explicit list of routes and jobs. In the starter, the
customer API serves tenants and notes and selects the notes attachment
worker. The staff API selects tenant routes and starts with an empty job
list. Both call the same service provider and use the same composed access
model.
[Customer entry point](../../../apps/kit-workbench/apps/customer/app.ts) ·
[Staff entry point](../../../apps/kit-workbench/apps/staff/app.ts)

<!-- dads:excerpt {"path": "apps/kit-workbench/apps/customer/app.ts", "language": "ts", "from": "export function customerApp(provider: ServiceProvider) {", "through": "}"} -->

## Add a surface to one API

1. Export the route contribution from its domain plugin. The starter notes
   plugin declares the services it needs and uses them to build its routes.
   Its worker contribution has a separate export, so the host can select
   routes and jobs independently.
   [Notes plugin](../../../apps/kit-workbench/domains/notes/server/plugin.ts)
2. Add the plugin to the target entry point's `routes`. Use a separate route
   contribution when one domain has different customer and staff
   operations. Keep each operation's permission check even when the host
   selects a limited surface.
3. Run requests through both API compositions. The starter's integration
   test sends a valid customer request to the staff host and expects the
   unmounted notes route to return 404.
   [API selection proof](../../../apps/kit-workbench/tests/starter.integration.test.ts)

To try both hosts locally, follow the starter's existing-database instructions.
Keep the customer host running and start staff on a separate port with
`DADS_API=staff`. The notes plugin fixture shows a second composition with
shared storage and different route and job selections.
[Run the starter](../../../apps/kit-workbench/README.md#run-against-your-own-database) ·
[Notes fixture](../../../fixtures/plugin-notes/README.md)

When a plugin needs another vendor or shared dependency, give the host a
service to supply and keep vendor wiring at that integration boundary.
[Plugin contract](../../../packages/foundation/plugin/README.md) ·
[Dependency libraries](../../dependency-libraries.md) ·
[Independent Evolution Principle](../../principles.md)
