# `@dads-fixture/plugin-notes`

An example plugin built on `@dads-framework/plugin`: one route, one migration,
one access definition, one job, and one timer, composed with a host-provided
clock service.

`src/notes-plugin.test.ts` is the end-to-end proof of the plugin contract: the
route answers through `@dads-framework/http`, the job runs in the in-process
job queue, `discoverDomainMigrations` finds the migration under the plugin's
name, the access definition is the one `emitAccessIr(compileAccess(app.access))` emits, and stopping
the app clears the timer.

```sh
npm test -w @dads-fixture/plugin-notes
```

## Customer and staff APIs

The two entrypoints select different routes and jobs for the same notes
domain. The shared notes service carries the domain's access model and
migration folder. It contributes no HTTP routes or jobs on its own.

```text
src/
  apis/
    customer-api.ts   customer notes routes
    staff-api.ts      staff notes routes and count job
  notes-data.ts       shared service and database metadata
  surfaces/
    customer-notes.ts
    staff-notes.ts
    staff-notes-jobs.ts
```

Use the named composition from the entrypoint that starts each server.
Pass its `access` to the access model and its `migrationSources(root)` to
the migration runner. Both are available before calling `start()`.

[`api-selection.test.ts`](./src/apis/api-selection.test.ts) proves the staff
route answers through the staff API when authorized and is absent from the
customer API even for the same staff identity. It also proves that a selected
route requires the exact service it declared.

## Audit and feature flags

`src/apis/free-kits.test.ts` installs the audit and flags plugins into two
API compositions. Both APIs have their services. Only the public API selects
the public flag state and client diagnostics routes. Only the worker selects
audit retention jobs. The host passes the composed migration sources to the
runner and applies declared scope columns and exclusions through the audit
migration helper. Run `npm test -w @dads-fixture/plugin-notes` to exercise the
fixture.
