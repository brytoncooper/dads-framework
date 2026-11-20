# Upgrade a Dads project

Check the target release's package README and generated API reference before
updating dependencies. Keep the starter's first-party Dads packages on the
same release version and review the manifest and lockfile diff. Save a
passing `npm run verify` result before the upgrade so you can compare failures.

## Move from 0.2 to 0.3

Update your direct Dads dependencies together. The table lists package names
without their common `@dads-framework/` prefix. In `package.json`, install the
package before the first subpath slash. In source files, import the full path
shown on the right.

| 0.2 package                                    | 0.3 import                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `email-sender-core`                            | `email-sender/core` and `email-sender/core/testing`                                                              |
| `object-storage-core`                          | `object-storage/core` and `object-storage/testing`                                                               |
| `job-queue-core`                               | `job-queue/core`, `job-queue/core/testing` and `job-queue/core/provider`                                         |
| `feature-flags-http`, `feature-flags-postgres` | `feature-flags/http`, `feature-flags/postgres`                                                                   |
| `health`                                       | `http/health`                                                                                                    |
| `testing-import-nx`                            | `testing/nx`. The `dad-test-nx` and `dad-test-import-nx` executables ship with `testing`.                        |
| `telemetry-core`, `client-telemetry-core`      | `telemetry/core`, `client-telemetry/core`. Use each package's `/testing` entry point for its test helpers.       |
| `clock`, `request-work`, `diagnostics`         | `runtime/clock`, `runtime/request-work`, `runtime/diagnostics`. The latter two retain their `/testing` subpaths. |

For example, replace an `@dads-framework/email-sender-core` dependency with
`@dads-framework/email-sender` and import your port from
`@dads-framework/email-sender/core`. Remove the old dependency after updating
its imports. A package version bump alone leaves those imports pointing at
the 0.2 contracts.

Check the drivers your app enables. Declare their optional peers directly
in your app so a clean production install includes them. For example, add
`resend` for the Resend driver, `bullmq` for the Redis queue, or
`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` for S3 and signed
URLs. The package READMEs list driver setup for [storage](../../../packages/server/object-storage/README.md),
[jobs](../../../packages/server/job-queue/README.md), [flags](../../../packages/server/feature-flags/README.md)
and [telemetry](../../../packages/server/telemetry/README.md). Run `npm install`,
review the lockfile, and exercise each configured driver.

### Preserve the starter migration

If your generated starter migration imports
`@dads-framework/feature-flags-postgres`, keep the migration file exactly as
deployed. Add `migrations/support/feature-flags.ts` with this export.

<!-- dads:excerpt {"path": "apps/kit-workbench/migrations/support/feature-flags.ts", "language": "ts", "from": "export { installFeatureFlagSchemaV1 } from \"@dads-framework/feature-flags/postgres\";", "through": "export { installFeatureFlagSchemaV1 } from \"@dads-framework/feature-flags/postgres\";"} -->

Add the following entry to `workspace.moduleAliases` in
`assembly/migrations.ts` so the runner can replay the original file on an
empty database.

<!-- dads:excerpt {"path": "apps/kit-workbench/assembly/migrations.ts", "language": "ts", "from": "      moduleAliases: {", "through": "          \"migrations/support/feature-flags.ts\","} -->

Add the following entry to `compilerOptions.paths` in `tsconfig.json` so
TypeScript follows the same mapping.

```json
{
  "@dads-framework/feature-flags-postgres": [
    "./migrations/support/feature-flags.ts"
  ]
}
```

For a custom migration that imports other symbols from the old package, add
those exports to the support module as well. Test the upgrade against both
an empty database and one with the original migration already applied.

## Check contracts and consumers

In the reference Workbench, the list-workspaces route declares
`workspaceResponse` as each response item. When an upgrade affects that
contract, regenerate the client and compare the affected operation and
schema with the previous version. The client parses each item with the
same schema. [Workspace route](../../../apps/workbench/src/routes.ts) ·
[Generated client](../../../apps/workbench/src/client.generated.ts)

```sh
npm run workbench:generate
git diff -- apps/workbench/src/client.generated.ts apps/workbench/src/contracts.ts
npm test -w @dads-app/workbench
```

These commands run from the framework checkout. In your app, use its own
client generation and consumer-test commands. If a field is added to an
existing schema, the generated source can stay the same because it imports
the schema. Review the schema diff and exercise the caller that reads the
field.

## Rehearse database and access changes

Run pending migrations against a restored test database before switching
traffic. Keep applied migration files intact. In the starter, point
`DATABASE_URL` at that test database and run `npm run migrate`. Then run
`npm run verify` with Docker running.

Smoke-test the deployed candidate with a member and a signed-in account
outside the tenant. A member can list notes on the customer API. The second
account gets a 404, and the staff host returns 404 for the same route even
when the member makes the request.
[Starter deployment checks](../../../apps/kit-workbench/DEPLOY.md#start-and-check)

## Move from earlier source checkouts

If your source branch split tables, forms, display, and shell components
across packages, move those imports to the current `@dads-framework/ui`
subpaths. For example, import `Input` from `@dads-framework/ui/forms`.
Update the dependency declarations with the imports and rerun the affected
form and table tests. [UI package reference](../../../packages/web/ui/README.md)
