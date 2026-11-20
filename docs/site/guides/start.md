# Why Dads

Removing someone from a workspace should also remove their access through
its activity feed. A copied membership check can drift and leave the feed
readable. Dads is a TypeScript backend framework that lets related routes
share a permission rule and declare what each API exposes.

[Start with the quickstart](./quickstart.md) to run a web app, PostgreSQL,
and two APIs from one project. If you already have an application,
[adopt one capability](./adopt.md) to try Dads in a smaller change.
Browse the [package examples](https://dadsframework.dev/docs/packages) for install commands, working code, and expected results.

## One codebase, two APIs

The starter has a customer API and a staff API. Both mount tenant routes.
Only the customer API mounts the notes plugin. A signed-in workspace member
can list notes there. An account without access gets a 404. The staff API
has no notes route at all.

The [staff entrypoint](../../../apps/kit-workbench/apps/staff/app.ts)
makes its route and job selection in one place.

<!-- dads:excerpt {"path": "apps/kit-workbench/apps/staff/app.ts", "language": "ts", "from": "export function staffApp(provider: ServiceProvider) {", "through": "}"} -->

The route, permission, and API composition can each change independently:

- **Contract.** The notes route declares its tenant parameter, pagination
  query, and response item schema. Dads validates requests and generates
  OpenAPI from the route definitions. See [HTTP and contracts](./http.md).
- **Permission.** Notes use the tenant's view permission. The notes query
  also scopes its reads to that tenant. See
  [permissions and relationships](./permissions.md).
- **Composition.** Each API chooses its own plugin list. Both can use the
  same tenant domain. See [API composition](./composition.md).

## What you take on

Dads asks you to keep schemas, access rules, and API entrypoints explicit.
That is additional work when you add a route. It gives you a place to change
each decision and a way to prove that the right access still holds.

The starter uses Fastify and PostgreSQL. Its PostgreSQL access adapter can
commit an application write and related permission changes in one transaction.
If your records and permissions live in separate systems, plan how those
systems will stay consistent. See the
[PostgreSQL access adapter](../../../packages/server/postgres-access/README.md).

Local signup and email delivery are part of the starter. For a public
deployment, configure mail, HTTPS, and secrets with the
[deployment guide](../../../apps/kit-workbench/DEPLOY.md).

## Start a Dads project

Follow the [quickstart](./quickstart.md) to create an account, save a note,
and find the source that decides where the note route runs.

## Verify and set up CI

Run `npm run verify` from the generated project. Commit
`package-lock.json` so the generated `ci/verify.sh` can install the same
dependencies and run the same checks. See the [portable CI recipe](../../../ci/README.md).

Use [change-aware verification](./verification.md) for focused feedback
while you work. The [guarded resource walkthrough](./guarded-resource.md)
traces a permission from its definition to an HTTP denial test.

## Try it with three accounts

The starter can set up an owner, an invited member, and an outsider in a local workspace. Open **Examples** in its browser app to inspect effective permissions, export audit records, or try directory provisioning against the running APIs. [Set up the example workspace](../../../apps/kit-workbench/examples/README.md)
