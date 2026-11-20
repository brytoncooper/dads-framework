# Why Dads

Imagine removing someone from a workspace on Friday. On Monday, can they
still read its activity feed? A passing test for the task detail page tells
you very little about the feed, the list, or the next endpoint someone adds.

I’d reach for Dads on a team that keeps shipping features around shared
records. You can read a route and see what it accepts, what it returns,
and who can call it. You can change a permission in its owning domain
and test what that change means for every feature that uses it.

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

For an app with teams, shared records, and changing roles, the cost of an
explicit contract and permission rule pays off each time another feature
needs the same decision. For a small service with a few public endpoints,
a router and a validator may be plenty. An existing TypeScript app can
also adopt just permissions, email, or another [standalone capability](./adopt.md).

## Try the decision yourself

Run the [quickstart](./quickstart.md) with Node 24 and Docker. Create a
workspace, save a note, then open **Examples**. The [example setup](../../../apps/kit-workbench/examples/README.md)
gives you an owner, a member, and an outsider so you can try the same request
with different access. The generated app’s `npm run verify` runs its checks.
