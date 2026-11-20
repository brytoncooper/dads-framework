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
npm install @dads-framework/feature-flags @dads-framework/clock
```

Save as `pilot.mts` and run `node pilot.mts` with Node.js 22.18 or newer.
The script enables invoice export for one tenant in memory.

<!-- dads:check-example -->

```ts
import {
  composeFeatureFlags,
  defineFeatureFlag,
} from "@dads-framework/feature-flags";
import {
  InMemoryFeatureFlagStore,
  FakeTenantDirectory,
} from "@dads-framework/feature-flags/testing";
import { SystemClock } from "@dads-framework/clock";

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
- `FeatureFlagStore` is the storage port. `@dads-framework/feature-flags-postgres`
  implements it; `InMemoryFeatureFlagStore` in `/testing` is the in-memory one.
  `verifyFeatureFlagStoreConformance(createStore)` in `/testing` is the suite
  both pass; run it against any store you write.
- `FeatureFlagContext` is `{ kind: "platform" }` or
  `{ kind: "tenant", tenantId }`. The platform context counts flags that are
  on for everyone only.
- `@dads-framework/feature-flags/contract` holds the Zod schemas, route paths
  and header names, with no server code, for a client to import.
- `@dads-framework/feature-flags-http` serves the routes and the per-request
  evaluator; `@dads-framework/client-feature-flags` reads the state in a
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
tenant directory, and clock through `featureFlagDepsService`. The service
has no HTTP routes. Select a separate route or storage plugin where needed.
