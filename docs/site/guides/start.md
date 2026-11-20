# Why Dads

Say the first thing your customer needs is a shared notebook. You want to
get a note from the browser into the database and back onto the screen.
With Dads, you can try that whole loop on your first run. Sign in, create
a workspace, save a note, and refresh. Then open the code that did it.

## Start where your own feature begins

Run `npm create dads@latest my-app` with Node 24 and Docker running.
The creator installs the app, starts PostgreSQL, applies migrations, and
prints the web URL. The notes feature is ordinary TypeScript in your
project. Three files show how the pieces fit together.

| When you want to…                          | Open this file in your app                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Change what the client can send or receive | [`domains/notes/contract/wire.ts`](../../../apps/kit-workbench/domains/notes/contract/wire.ts)       |
| Follow a request into the database         | [`domains/notes/server/routes.ts`](../../../apps/kit-workbench/domains/notes/server/routes.ts)       |
| See how the browser calls the API          | [`domains/notes/web-client/index.ts`](../../../apps/kit-workbench/domains/notes/web-client/index.ts) |

The reason to choose Dads is what happens on the **second** feature.
Your team already has a working example, a place to put the new code, and
a boundary check for imports that reach into another domain. The route
contract feeds request validation, OpenAPI, and typed clients. You can
spend the next change on what the feature does. [Build a resource in the starter](./guarded-resource.md).

New to terms like _domain_, _contract_, or _kit_? The [Dads vocabulary](./vocabulary.md) shows what each one means in this app.

## What happens when access changes?

The Workbench gives Bob access to Alice’s workspace. He can read its task
and activity. Alice removes him. The same test tries the task, claim,
artifact, and activity operations again and proves Bob has lost access.
[Read the revocation test](../../../apps/workbench/src/workbench-api.test.ts).

The starter shows how to build a smaller version yourself. Its notes route
uses the workspace’s view permission and takes the workspace ID from the
URL. Here is the actual declaration.

<!-- dads:excerpt {"path":"apps/kit-workbench/domains/notes/access/index.ts","language":"ts","from":"export const notesPermission = tenantAccess.tenant.permissions.view;","through":"};"} -->

A list has one more job. Its database query must use the authorized workspace
for **both the rows and the count**. The starter applies the same predicate
to both. A member sees their workspace’s notes. A signed-in outsider who
requests that workspace gets a 404. [Follow the query and its denial test](./guarded-resource.md).

## What happens when the API changes?

Suppose you add a field to a database table. The public response still has
its own explicit schema. When you decide to expose the field, that contract
also describes it to OpenAPI and to a client using the same schema. The
application code behind the handler stays plain TypeScript.
[See the route, response, and client together](./http.md).

If you later need a staff API, select the domains it exposes in its
entrypoint. The customer API can keep using the same domains. You can make
that decision after the first API is already useful. [API composition](./composition.md).

## When I’d choose it

Choose the full framework when you expect multiple features or developers
to share a backend and want a working structure from the first commit. For a small service with a few public endpoints,
a router and a validator may be plenty. An existing TypeScript app can
also adopt just permissions, email, or another [standalone capability](./adopt.md).

## Try the decision yourself

Run the [quickstart](./quickstart.md) with Node 24 and Docker. Create a
workspace, save a note, then open **Examples**. The [example setup](../../../apps/kit-workbench/examples/README.md)
gives you an owner, a member, and an outsider so you can try the same request
with different access. The generated app’s `npm run verify` runs its checks.
