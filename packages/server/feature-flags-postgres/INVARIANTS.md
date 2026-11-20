# Feature flags Postgres invariants

Rules about how flag states and their history are kept in Postgres.

- INV-FEATUREFLAGSPG-1: States, pilot tenants and history rows of one batch commit together or not at all. — enforced by `src/lib/drizzle-feature-flag-store.ts#DrizzleFeatureFlagStore`; proven by `src/lib/drizzle-feature-flag-store.integration.test.ts` "rolls back the whole batch when a later flag has a revision conflict".
- INV-FEATUREFLAGSPG-2: `global_enabled_at` is set exactly while the mode is EVERYONE. — enforced by `src/lib/migrations/20261119180000_feature_flags.migration.ts#createStates`; proven by `src/lib/drizzle-feature-flag-store.integration.test.ts` "refuses EVERYONE without a global activation time at the database".
