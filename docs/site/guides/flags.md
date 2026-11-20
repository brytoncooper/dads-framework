# Feature flags

Use a flag when a capability should reach some audiences before others. In
the starter, the notes panel offers PDF and CSV downloads when the active
workspace's `notes.export` flag is on.
[Run the browser workbench](../../../apps/kit-workbench/README.md)

## Trace the notes export flag

The notes domain defines the flag in code and names its owner, capability,
default, and cleanup trigger. The plugin contributes that definition. The
starter's example database migration enables it for everyone, so a fresh
starter demonstrates downloads even though the definition defaults to off.
[Flag definition](../../../apps/kit-workbench/domains/notes/server/flags.ts) ·
[Notes plugin](../../../apps/kit-workbench/domains/notes/server/plugin.ts) ·
[Example enablement migration](../../../apps/kit-workbench/migrations/20261120080200_enable_notes_exports.migration.ts)

The browser reads `GET /api/tenants/:tenantId/notes/features` for the active
workspace. The server guards the tenant route and evaluates the flag for
that tenant. Export requests have their own server-side checks. A flag can
hide or reveal a feature for an audience, while the authorization rule
still governs access to its data.
[Feature state route](../../../apps/kit-workbench/domains/notes/server/routes.ts) ·
[Export routes](../../../apps/kit-workbench/domains/notes/server/exports.ts)

When adding your own flag, test the off state, one enabled tenant, and a
caller without membership. Use revision-checked updates when changing flag
state, and put the removal condition in the flag definition so a completed
rollout has a clear cleanup step.
[Feature flag kit](../../../packages/server/feature-flags/README.md) ·
[Postgres storage](../../../packages/server/feature-flags-postgres/README.md) ·
[HTTP binding](../../../packages/server/feature-flags-http/README.md)
[Flag composition test](../../../packages/server/feature-flags/src/lib/compose-feature-flags.test.ts)
