# Compose APIs and plugins

[`apps/customer/app.ts`](../../../apps/kit-workbench/apps/customer/app.ts)
chooses which routes and jobs run on the customer API. It imports Notes
through the domain's public entry point.

<!-- dads:excerpt {"path": "apps/kit-workbench/apps/customer/app.ts", "language": "ts", "from": "export function customerApp(provider: ServiceProvider) {", "through": "}"} -->

## Export routes from the domain

[`domains/notes/index.ts`](../../../apps/kit-workbench/domains/notes/index.ts)
exposes two contributions. The API can select the routes and attachment
worker independently.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/index.ts", "language": "ts", "from": "export { notesAttachmentWorker, notesPlugin } from \"./server/plugin.js\";", "through": "export { notesAttachmentWorker, notesPlugin } from \"./server/plugin.js\";"} -->

[`domains/notes/server/plugin.ts`](../../../apps/kit-workbench/domains/notes/server/plugin.ts)
gets the services from the host and passes them to the domain's route
factories. Each protected route still declares its own access rule.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/server/plugin.ts", "language": "ts", "from": "export const notesPlugin = definePlugin({", "through": "      ],\n    };\n  },\n});"} -->

## Test the same request on both APIs

[`apps/staff/app.ts`](../../../apps/kit-workbench/apps/staff/app.ts)
selects tenant routes and the audit export, with an empty jobs array.

<!-- dads:excerpt {"path": "apps/kit-workbench/apps/staff/app.ts", "language": "ts", "from": "export function staffApp(provider: ServiceProvider) {", "through": "}"} -->

The [starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
sends the same signed-in member and Notes URL to both APIs. Customer returns
**200** with the note. Staff returns **404** because the route is absent.
Customer also returns **404** when the signed-in caller lacks tenant access.
Run all three assertions from the generated app with Docker running.

```sh
npm test -- tests/starter.integration.test.ts
```
