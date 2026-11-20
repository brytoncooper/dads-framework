# Generate application code

Run these commands at the root of a Dads kit starter. Use `dad add --help`
to see the available generators.

| Command                                                | What it adds                                                                                             |
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

Use `--dry-run --json` to inspect the planned changes. Generators only write
new files or explicit registry entries, including those marked with comments
in the starter. An unchanged rerun creates no duplicate entries. A file
collision aborts before changes are written.

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
