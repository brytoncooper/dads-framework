# Feature flags invariants

Rules about code-owned flag definitions, their stored audiences, and the
effective state one context sees.

- INV-FEATUREFLAGS-1: Evaluation walks the definitions, so a stored row for a slug the code does not define never becomes a feature. — enforced by `src/lib/logic/evaluate-feature-flags.ts#evaluateFeatureFlags`; proven by `src/lib/logic/feature-flag-state.test.ts` "never turns on a stored row whose slug is not defined".
- INV-FEATUREFLAGS-2: The platform context counts EVERYONE only; a tenant context also counts its own pilot while its `enabledAt` is set. — enforced by `src/lib/logic/evaluate-feature-flags.ts#evaluateFeatureFlags`; proven by `src/lib/logic/feature-flag-state.test.ts` "counts a pilot only in its own tenant context and only while its enabledAt is set".
- INV-FEATUREFLAGS-3: Pilot tenants survive OFF and EVERYONE with `enabledAt` cleared, and their timing restarts when they are selected again. — enforced by `src/lib/logic/transition-feature-flag-state.ts#transitionFeatureFlagState`; proven by `src/lib/logic/feature-flag-state.test.ts` "keeps selected pilot timing only while selected and starts it again on return".
- INV-FEATUREFLAGS-4: Each change carries `expectedRevision`; one mismatch refuses the whole batch with `FEATURE_FLAG_STATE_CHANGED`. — enforced by `src/lib/mutations/plan-feature-flag-batch.ts#planFeatureFlagBatch`; proven by `src/lib/mutations/update-feature-flags.test.ts` "does not partially apply a batch when a revision is stale".
- INV-FEATUREFLAGS-5: A definition is off by default and affects at least one page or API capability. — enforced by `src/contract/feature-flag-definition.schema.ts#featureFlagDefinitionSchema`; proven by `src/contract/feature-flag-contract.test.ts` "rejects a definition that is on by default".
- INV-FEATUREFLAGS-6: The public state answers only for the declared public list, evaluated as the platform. — enforced by `src/lib/queries/get-public-feature-state.ts#GetPublicFeatureState`; proven by `src/lib/compose-feature-flags.test.ts` "never lists a public flag that is on only for selected tenants".

## PostgreSQL invariants

Rules about how flag states and their history are kept in Postgres.

- INV-FEATUREFLAGSPG-1: States, pilot tenants and history rows of one batch commit together or not at all. — enforced by `src/postgres/drizzle-feature-flag-store.ts#DrizzleFeatureFlagStore`; proven by `src/postgres/drizzle-feature-flag-store.integration.test.ts` "rolls back the whole batch when a later flag has a revision conflict".
- INV-FEATUREFLAGSPG-2: `global_enabled_at` is set exactly while the mode is EVERYONE. — enforced by `src/postgres/migrations/20261119180000_feature_flags.migration.ts#createStates`; proven by `src/postgres/drizzle-feature-flag-store.integration.test.ts` "refuses EVERYONE without a global activation time at the database".
