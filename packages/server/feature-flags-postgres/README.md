# `@dads-framework/feature-flags-postgres`

The Postgres store for `@dads-framework/feature-flags`: one node-pg-migrate
migration, the Drizzle tables it creates, and `DrizzleFeatureFlagStore`, which
writes a batch of flag changes and their history in one transaction.

## Try it

```ts
import { composeFeatureFlags } from "@dads-framework/feature-flags";
import { DrizzleFeatureFlagStore } from "@dads-framework/feature-flags-postgres";

const flags = composeFeatureFlags({
  definitions,
  store: new DrizzleFeatureFlagStore(db), // db: a DrizzleHandle from @dads-framework/postgres
  tenants,
  clock,
});
```

## Use it

- `src/lib/migrations/20261119180000_feature_flags.migration.ts` creates
  `feature_flag_states`, `feature_flag_tenant_targets` and
  `feature_flag_change_events`. Run it with your node-pg-migrate setup.
  `installFeatureFlagSchemaV1(pgm)` and `removeFeatureFlagSchemaV1(pgm)` are
  the same `up` and `down`, for a migration of your own to call.
- `DrizzleFeatureFlagStore(db)` implements `FeatureFlagStore`.
- `featureFlagStates`, `featureFlagTenantTargets` and
  `featureFlagChangeEvents` are the Drizzle tables, for reads of your own.

## What it refuses to do

- It never writes part of a batch. A stale revision, or a first write that
  loses the race to another, rolls back every state, tenant and history row
  in the batch and answers `revision-conflict`.
- It never updates or deletes a history row. Code only inserts there.
- It never stores `EVERYONE` without `global_enabled_at`, or any other mode
  with it: a `CHECK` constraint holds that.

## Contract

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
