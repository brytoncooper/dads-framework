# `@dads-framework/feature-flags`

Feature flags defined in code, with a stored audience per flag: off, on for
the tenants you select, or on for everyone. Every change is revision-checked,
applied in batches that land together or not at all, and recorded in history.
The application decides what a tenant is.

## What Dad does for you

A flag lives in code, so it is reviewed, owned, and deleted like code. Only
who sees it is stored, and nothing stored can invent a flag the code never
defined.

## Try it

Install the flag kit.

```sh
npm install @dads-framework/feature-flags @dads-framework/runtime
```

Save as `pilot.mts` and run `node pilot.mts` with Node.js 22.18 or newer.
The script enables invoice export for one tenant in memory.

<!-- dads:check-example -->

```ts
import { composeFeatureFlags, defineFeatureFlag } from "@dads-framework/feature-flags";
import { InMemoryFeatureFlagStore, FakeTenantDirectory } from "@dads-framework/feature-flags/testing";
import { SystemClock } from "@dads-framework/core/runtime/clock";

const bulkExport = defineFeatureFlag({
  slug: "billing.invoices.bulk-export",
  name: "Bulk invoice export",
  description: "Export every invoice in a period as one file.",
  owner: "billing team",
  defaultEnabled: false,
  affectedPages: ["/invoices"],
  affectedApiCapabilities: ["POST /invoices/exports"],
  cleanupTrigger: "Removed after two weeks on for everyone.",
  globalStabilityDays: 14,
});

const flags = composeFeatureFlags({
  definitions: [bulkExport],
  store: new InMemoryFeatureFlagStore(),
  tenants: new FakeTenantDirectory(),
  clock: new SystemClock(),
});

await flags.update.execute({
  actorId: "user-1",
  request: {
    changes: [
      {
        slug: bulkExport.slug,
        expectedRevision: 0,
        mode: "SELECTED_TENANTS",
        tenantIds: ["acme"],
      },
    ],
  },
});

console.log(
  await flags.evaluator.isActive({
    slug: bulkExport.slug,
    context: { kind: "tenant", tenantId: "acme" },
  }),
);
console.log(
  await flags.evaluator.isActive({
    slug: bulkExport.slug,
    context: { kind: "platform" },
  }),
);
```

The script prints `true` for Acme and `false` for the platform. The
selected-tenant rollout leaves the platform audience off.

The generated starter defines the note-export flag in
[`domains/notes/server/flags.ts`](../../../apps/kit-workbench/domains/notes/server/flags.ts) and contributes it from
[`domains/notes/server/plugin.ts`](../../../apps/kit-workbench/domains/notes/server/plugin.ts). The service in
[`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts) evaluates the API’s declared flags.

## Use it

- `defineFeatureFlag(definition)` parses a definition where it is declared.
  A definition is off by default and names at least one affected page or API
  capability.
- `composeFeatureFlags({ definitions, publicSlugs?, store, tenants, clock, readPreview? })`
  returns `management`, `history`, `update`, `effective`, `publicState`,
  `evaluator`, and `evaluatorReadingStatesOncePerRequest`.
- `readPreview(context)` optionally supplies an authorized request override
  for one defined flag. Effective state and both evaluators include the override.
  The public list, management views, rollout state, and history use stored audiences.
- `TenantDirectory` is the application's port: `findActiveTenants(ids)`
  answers which ids are active tenants and what they are called.
- `FeatureFlagStore` is the storage port. `@dads-framework/feature-flags/postgres`
  implements it; `InMemoryFeatureFlagStore` in `/testing` is the in-memory one.
  `verifyFeatureFlagStoreConformance(createStore)` in `/testing` is the suite
  both pass; run it against any store you write.
- `FeatureFlagContext` is `{ kind: "platform" }` or
  `{ kind: "tenant", tenantId }`. The platform context counts flags that are
  on for everyone only.
- `@dads-framework/feature-flags/contract` holds the Zod schemas, route paths
  and header names, with no server code, for a client to import.
- `@dads-framework/feature-flags/http` serves the routes and the per-request
  evaluator; `@dads-framework/feature-flags/react` reads the state in a
  browser.

## What it refuses to do

- It never stores a definition. A stored row for a slug the code no longer
  defines is never evaluated and never listed.
- It never applies part of a batch. One stale `expectedRevision` refuses the
  whole batch.
- It never selects a tenant the `TenantDirectory` does not report as active.
- It never shows a selected-tenants pilot to the platform context or to the
  public state.
- It never decides who may manage flags. The HTTP binding asks the
  application's `Authorization` with the permission the application names.

## Contract

| Shape                       | Fields                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `FeatureFlagState`          | `slug`, `audienceMode`, `rememberedTenants[]`, `revision`, `globalEnabledAt`, `updatedAt`, `updatedBy`     |
| `UpdateFeatureFlagsRequest` | `changes[]`: `{ slug, expectedRevision, mode, note? }`, plus `tenantIds` when `mode` is `SELECTED_TENANTS` |
| `FeatureFlagHistoryEntry`   | `batchId`, `slug`, `revision`, `previousState`, `nextState`, `note?`, `changedAt`, `changedBy`             |
| `EffectiveFeatureState`     | `features` (sorted slugs that are on), `stateHash` (SHA-256 of that list)                                  |
| `PublicFeatureState`        | `features` (public-list slugs that are on for everyone)                                                    |

| Error code                       | Kind       | When                                                        |
| -------------------------------- | ---------- | ----------------------------------------------------------- |
| `FEATURE_FLAG_STATE_CHANGED`     | conflict   | an `expectedRevision` is not the stored revision            |
| `FEATURE_FLAG_NOT_FOUND`         | not-found  | a batch or history read names a slug the code never defined |
| `FEATURE_FLAG_CHANGE_DUPLICATED` | validation | one batch names the same slug twice                         |
| `FEATURE_FLAG_TENANT_NOT_FOUND`  | not-found  | a selected tenant is not active                             |

`composeFeatureFlags` throws at startup when a slug is defined twice or a
public slug is not defined.

## Install as a plugin

`createFeatureFlagsPlugin({ definitions, publicSlugs })` declares the flag
definitions and offers `featureFlagsService`. The API host supplies the store,
tenant directory, and clock through `featureFlagDepsService`. Import a route
or storage plugin below when needed.

## HTTP routes and previews

Serves `@dads-framework/feature-flags` through the HTTP kit: management
routes guarded by a permission the application names, the caller's effective
feature state, the public list, and the evaluator the kit runs once per
request.

### Try it

Install the flag kit and its HTTP binding.

```sh
npm install @dads-framework/feature-flags @dads-framework/http @dads-framework/access
```

Save as `flag-routes.mts` and run `node flag-routes.mts` with Node.js 22.18 or
newer. The test harness runs requests in process and denies all permission
checks by default.

<!-- dads:check-example -->

```ts
import { composeFeatureFlags } from "@dads-framework/feature-flags";
import {
  FakeTenantDirectory,
  featureFlagDefinitionFactory,
  FixedClock,
  InMemoryFeatureFlagStore,
} from "@dads-framework/feature-flags/testing";
import { createFeatureFlagRoutes } from "@dads-framework/feature-flags/http";
import { fromFixed } from "@dads-framework/http";
import { buildTestApp, TEST_SUBJECT_HEADER } from "@dads-framework/http/testing";

const exportFlag = featureFlagDefinitionFactory({ slug: "orders.export" });
const flags = composeFeatureFlags({
  definitions: [exportFlag],
  publicSlugs: [exportFlag.slug],
  store: new InMemoryFeatureFlagStore(),
  tenants: new FakeTenantDirectory(),
  clock: new FixedClock(new Date("2026-01-01T00:00:00Z")),
});
await flags.update.execute({
  actorId: "example-operator",
  request: {
    changes: [{ slug: exportFlag.slug, expectedRevision: 0, mode: "EVERYONE" }],
  },
});

const app = await buildTestApp({
  routes: createFeatureFlagRoutes({
    featureFlags: flags,
    manage: {
      kind: "permission",
      resourceType: "app/settings",
      permission: "manage_feature_flags",
      resourceId: fromFixed("main"),
    },
  }),
});
try {
  const publicState = await app.inject({
    method: "GET",
    url: "/feature-state/public",
  });
  console.log(publicState.statusCode, publicState.body);

  const management = await app.inject({
    method: "GET",
    url: "/feature-flags",
    headers: { [TEST_SUBJECT_HEADER]: "example-user" },
  });
  console.log(management.statusCode);
} finally {
  await app.close();
}
```

The anonymous public request returns `200` with `orders.export` in
`data.features`. The signed-in caller has no management permission, so the
second request returns `404`.

The repo-only [`src/http/feature-flag-routes.test.ts`](src/http/feature-flag-routes.test.ts) mounts these
routes and checks public reads and management access. The generated starter
wires the package’s request evaluator in [`assembly/feature-previews.ts`](../../../apps/kit-workbench/assembly/feature-previews.ts).

### Use it

- `createFeatureFlagRoutes({ featureFlags, manage, tag? })` returns the
  route group below.
- `FeatureFlagRequestEvaluator(effective, resolveContext)` is the HTTP kit's
  `FeatureStateRequestEvaluator`. `resolveContext` is where the application
  says which tenant a request acts in. Resolve it from what the session
  proves, not from a header alone, when tenants must not read each other's
  pilots.

#### Scoped previews

Set `readPreview: readFeatureFlagPreview` when composing the flags. Set
`featureState.preview.resolver` to `createFeatureFlagPreviewResolver` and
choose the request and dropped-response headers in `featureState.preview`.
Use the composed flags’ definitions in the preview resolver and share
`resolveContext` with `FeatureFlagRequestEvaluator`.

The host supplies `findPreview(previewId)` to look up a typed record with
`owner`, `context`, `feature`, `active`, `allowsWrites` and `expiresAt`.
The host issues and revokes those records separately from rollout settings.
Its `canPreview({ subject, context, feature })` verifies current preview
permission, including the caller's relationship to the selected tenant. A
context header is only a hint for that check. The resolver also checks the
record's owner, context, expiry and flag definition before applying it.
Requests with a valid preview receive a private, non-cacheable response.

### What it refuses to do

- It never answers a management route to a caller without the `manage`
  permission. The HTTP kit asks the application's `Authorization` first and
  answers a refusal with 404, the same as an unknown route.
- It never decides the tenant itself. A request the resolver answers `null`
  for carries no feature state.

### Contract

| Route                              | Access            | Answers                                                               |
| ---------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `GET /feature-flags`               | `manage`          | `FeatureFlagManagementList`                                           |
| `GET /feature-flags/:slug/history` | `manage`          | paged `FeatureFlagHistoryEntry`                                       |
| `POST /feature-flags`              | `manage`          | `{ states: FeatureFlagState[] }`                                      |
| `GET /feature-state`               | signed-in session | `EffectiveFeatureState`; the platform answer when no context resolves |
| `GET /feature-state/public`        | public            | `PublicFeatureState`                                                  |

Errors are the core package's, mapped by the HTTP kit: conflict 409,
not-found 404, validation 400.

`createFeatureFlagRoutesPlugin()` serves the configured public flag list.
Supply `{ manage }` to select the management routes and the signed-in effective
state route as well. Add the plugin only to the API route list that should
receive those operations. The selected API needs `featureFlagsService`.

## PostgreSQL storage

The Postgres store for `@dads-framework/feature-flags`: one node-pg-migrate
migration, the Drizzle tables it creates, and `DrizzleFeatureFlagStore`, which
writes a batch of flag changes and their history in one transaction.

### Try it

Use a fresh Postgres database for the example and export its connection URL
as `DATABASE_URL`. Install the store and the migration runner.

```sh
npm install @dads-framework/feature-flags @dads-framework/postgres drizzle-orm node-pg-migrate
mkdir -p migrations
```

Save this as `migrations/1767225600000_feature_flags.mjs`.

```js
export {
  installFeatureFlagSchemaV1 as up,
  removeFeatureFlagSchemaV1 as down,
} from "@dads-framework/feature-flags/postgres";
```

Apply the migration.

```sh
npx node-pg-migrate up
```

Save as `read-flag-store.mts` and run `node read-flag-store.mts` with Node.js
22.18 or newer.

<!-- dads:check-example -->

```ts
import { DrizzleFeatureFlagStore, featureFlagStates } from "@dads-framework/feature-flags/postgres";
import { createPostgresConnection } from "@dads-framework/postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL before running this script.");

const connection = createPostgresConnection({ connectionString, schema: { featureFlagStates } }, console);
try {
  const store = new DrizzleFeatureFlagStore(connection.drizzle);
  console.log(await store.listStates(["orders.export"]));
} finally {
  await connection.close();
}
```

The script prints `[]`. The migration creates the tables, and the store
finds no persisted audience for `orders.export` in the fresh database.

The generated starter creates the store in [`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts)
using its shared Drizzle connection. The repo’s
[`src/postgres/drizzle-feature-flag-store.integration.test.ts`](src/postgres/drizzle-feature-flag-store.integration.test.ts) exercises
that store against PostgreSQL.

### Use it

- `src/postgres/migrations/20261119180000_feature_flags.migration.ts` creates
  `feature_flag_states`, `feature_flag_tenant_targets` and
  `feature_flag_change_events`. Run it with your node-pg-migrate setup.
  `installFeatureFlagSchemaV1(pgm)` and `removeFeatureFlagSchemaV1(pgm)` are
  the same `up` and `down`, for a migration of your own to call. The shipped
  migration retains the original filename and checksum from
  `@dads-framework/feature-flags-postgres`.
- `DrizzleFeatureFlagStore(db)` implements `FeatureFlagStore`.
- `featureFlagStates`, `featureFlagTenantTargets` and
  `featureFlagChangeEvents` are the Drizzle tables, for reads of your own.

### What it refuses to do

- It never writes part of a batch. A stale revision, or a first write that
  loses the race to another, rolls back every state, tenant and history row
  in the batch and answers `revision-conflict`.
- It never updates or deletes a history row. Code only inserts there.
- It never stores `EVERYONE` without `global_enabled_at`, or any other mode
  with it: a `CHECK` constraint holds that.

### Contract

| Table                         | Key columns                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `feature_flag_states`         | `slug` (unique), `audience_mode`, `global_enabled_at`, `updated_by`, `row_version`   |
| `feature_flag_tenant_targets` | `feature_flag_state_id`, `tenant_id` (unique together), `tenant_name`, `enabled_at`  |
| `feature_flag_change_events`  | `batch_id`, `slug`, `revision`, `previous_state`, `next_state`, `note`, `changed_by` |

`row_version` is the wire's `revision`. Tenant and actor ids are `text`: the
application decides their format. `applyBatch` answers `"applied"` or
`"revision-conflict"`; any other database error is thrown.

Select `featureFlagsPostgresSchema` when the application uses this store. The
plugin contributes the original TypeScript migration to
`api.migrationSources(root)` and opens no connection. Pass a
`DrizzleFeatureFlagStore` through the host-supplied flag dependencies.
