# Generate application code

## Add inventory to the staff API

From the root of an installed starter, create an inventory domain. Preview a resource called `item` before you add it to the staff API.

```sh
npx dad add domain inventory
npx dad add resource item --domain inventory --api staff --dry-run --json
```

Look in `result.files` for `apps/staff/app.ts`, `domains/inventory/server/item-reader.ts`, and `domains/inventory/server/item-writer.ts`. The first wires the resource into the staff API. The other two hold its database reads and writes. The preview leaves those files untouched.

Apply the change and preview it again:

```sh
npx dad add resource item --domain inventory --api staff
npx dad add resource item --domain inventory --api staff --dry-run --json
```

The second preview returns:

```json
{
  "ok": true,
  "result": {
    "kind": "resource",
    "domain": "inventory",
    "files": [],
    "dryRun": true
  }
}
```

Install from your configured package source, apply the migration to your development database, and exercise the generated route test.

```sh
npm install
npm run migrate
npm test -- domains/inventory/server/item-resource.test.ts
```

The test submits an edit from an outsider and a stale edit from an authorized owner. Open it beside `domains/inventory/server/item-resource.ts` to see the permission and version checks.

## Choose a generator

| Generator                                              | What it adds                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `dad add domain inventory`                             | A domain with contract, access, server and web-client surfaces                                           |
| `dad add endpoint status --domain inventory`           | An authenticated GET operation and its route proof                                                       |
| `dad add table bin --domain inventory`                 | A tenant-scoped Postgres table and an app-registered migration                                           |
| `dad add access bin --domain inventory`                | An editor relationship with view and edit permissions                                                    |
| `dad add flag batch --domain inventory`                | An inactive feature flag contributed by the domain                                                       |
| `dad add email receipt --domain inventory`             | A domain-owned email template and render proof                                                           |
| `dad add page overview --domain inventory`             | A domain-owned page renderer and test                                                                    |
| `dad add resource item --domain inventory --api staff` | A complete versioned resource with list, read and update routes, access, Postgres adapters and web pages |
| `dad add library catalog-records`                      | An [app-owned TypeScript package](dependency-libraries.md) with a public contract                        |

Add `--api customer` or `--api staff` to a domain or endpoint command to
select the domain in that API. A resource requires an API selection. If a
domain is already selected by multiple APIs, each selection includes its
domain routes. Adding a new domain without an API leaves it unmounted.

Email and resource generators add package dependencies, and the library
generator adds an npm workspace. Run `npm install` from the app root using
your configured package source if `package.json` changed. Commit the updated
lockfile and run `npm run verify`. Apply the generated migration before
serving the resource.

The resource routes sit under `/api/tenants/:tenantId/<domain>/<resource>`.
The tenant view permission controls lists and reads, and the tenant management
permission controls updates. All database operations use the authorized tenant
and writes use [stale-save protection](architecture/stale-save.md). The resource exports its
client functions and list/detail components from
`domains/<domain>/web-client/index.ts`. Import that entry point from your
app’s web composition. Use the list and read functions in your route loaders,
and call the save function from the detail page’s `onSave` callback. You
choose the browser routes, URLs, and loading and conflict states. Standalone
pages are exported through the same entry point. If the web entry point is
already customized, add a `// dad:add exports` line where generated exports
should appear.
Resource creation and tenant membership changes belong to the application's
workflow.

The [packed adoption proof](../scripts/adoption/verify-generated-project.mjs)
runs all nine generators on a fresh starter, installs the app's Dads packages
from local tarballs, and runs the starter's CI command.
