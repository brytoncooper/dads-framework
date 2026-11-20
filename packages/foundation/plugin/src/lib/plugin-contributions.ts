/**
 * The shapes a plugin contributes. The kernel names only what it checks
 * (a job's `name`, a flag's `slug`, an access entity's `wireName`); the item
 * types themselves stay the owning kit's, carried through by inference, so
 * this package depends on no kit and every kit may depend on it.
 */

/** A job as the kernel sees it: its name must be unique in the app. */
export type NamedJob = { readonly name: string };

/** A feature flag as the kernel sees it: its slug must be unique in the app. */
export type SluggedFlag = { readonly slug: string };

/**
 * An access definition as the kernel sees it: the value `access()` returns.
 * Its entity's wire name must be unique in the app.
 */
export type AccessContribution = {
  readonly entity: { readonly wireName: string };
};

/**
 * A folder of `<timestamp>_<slug>.migration.ts` files. `directory` is
 * absolute, so the plugin does not need to know where the app installed it:
 * `fileURLToPath(new URL("./migrations/", import.meta.url))`.
 */
export type MigrationFolder = {
  readonly directory: string;
  /** A missing required folder fails the migration run. Default true. */
  readonly required?: boolean;
};

/** Scope dimensions declared for one of the plugin's tables. */
export type AuditScopeContribution = {
  readonly table: string;
  readonly columns: Readonly<Record<string, string>>;
};

/** Audit settings a plugin owns for its own tables. */
export type AuditSettings = {
  /** Tables the row-level audit trigger leaves alone (the allowlist). */
  readonly untrackedTables?: readonly string[];
  readonly scopes?: readonly AuditScopeContribution[];
};

/**
 * What a plugin declares before anything starts. These are readable from
 * `composeApp(plugins)` alone, so the migration runner, `dad doctor`, and
 * `dad orient` see them without booting the app.
 */
export type PluginContributions<
  Flag extends SluggedFlag,
  Access extends AccessContribution = AccessContribution,
> = {
  readonly migrations?: readonly MigrationFolder[];
  readonly access?: readonly Access[];
  readonly flags?: readonly Flag[];
  readonly audit?: AuditSettings;
};

/** Contributions with every list present. */
export type DeclaredContributions<
  Flag extends SluggedFlag,
  Access extends AccessContribution = AccessContribution,
> = {
  readonly migrations: readonly MigrationFolder[];
  readonly access: readonly Access[];
  readonly flags: readonly Flag[];
  readonly untrackedTables: readonly string[];
  readonly auditScopes: readonly AuditScopeContribution[];
};

/**
 * What setup returns: the value the plugin offers its dependents, and the
 * contributions that need running dependencies to build (a route's handler
 * closes over a store; a job's run closes over a clock).
 */
export type PluginRuntime<Provides, Route, Job extends NamedJob> = {
  readonly provides?: Provides;
  readonly routes?: readonly Route[];
  readonly jobs?: readonly Job[];
};

/** Setup's result with every list present. */
export type StartedContributions<Route, Job extends NamedJob> = {
  readonly routes: readonly Route[];
  readonly jobs: readonly Job[];
};

export function declaredContributions<
  Flag extends SluggedFlag,
  Access extends AccessContribution,
>(
  contributions: PluginContributions<Flag, Access> | undefined,
): DeclaredContributions<Flag, Access> {
  return {
    migrations: contributions?.migrations ?? [],
    access: contributions?.access ?? [],
    flags: contributions?.flags ?? [],
    ...declaredAudit(contributions?.audit),
  };
}

function declaredAudit(
  audit: AuditSettings | undefined,
): Pick<DeclaredContributions<never>, "untrackedTables" | "auditScopes"> {
  return {
    untrackedTables: audit?.untrackedTables ?? [],
    auditScopes: audit?.scopes ?? [],
  };
}
