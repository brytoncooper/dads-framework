import type { Plugin } from "./define-plugin.js";
import {
  migrationSourcesFor,
  type OwnedMigrationFolder,
  type PluginMigrationSource,
} from "./migration-sources.js";
import { orderPlugins } from "./order-plugins.js";
import type {
  AccessContribution,
  AuditScopeContribution,
  NamedJob,
  SluggedFlag,
} from "./plugin-contributions.js";
import { PluginCompositionError } from "./plugin-errors.js";
import { refuseDuplicates } from "./refuse-duplicates.js";
import { type RunningApp, startPlugins } from "./start-plugins.js";

/**
 * The compile-time half of the dependency check. Empty when every
 * dependency a plugin needs is offered by a plugin in the list; otherwise a
 * required extra argument whose type names what is missing, so the call
 * fails to compile ("Expected 2 arguments") and the hover says why.
 */
export type DependencyCheck<Offered extends string, Needed extends string> = [
  Exclude<Needed, Offered>,
] extends [never]
  ? []
  : [unmetDependency: `unmet dependency: ${Exclude<Needed, Offered>}`];

/** Everything the host wires, before anything starts. */
export type ComposedApp<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution = AccessContribution,
> = {
  /** Plugin names in setup order. */
  readonly plugins: readonly string[];
  /** Every access definition; entity wire names are unique. */
  readonly access: readonly Access[];
  /** Every feature-flag definition; slugs are unique. */
  readonly flags: readonly Flag[];
  /** Tables the audit trigger leaves alone, across every plugin. */
  readonly untrackedAuditTables: readonly string[];
  readonly auditScopes: readonly AuditScopeContribution[];
  /** Migration sources for a workspace rooted at `workspaceRoot`. */
  readonly migrationSources: (
    workspaceRoot: string,
  ) => readonly PluginMigrationSource[];
  /** Run every setup in order. Each call is an independent run. */
  readonly start: () => Promise<RunningApp<Route, Job>>;
};

type ComposablePlugin<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution = AccessContribution,
> = Plugin<string, string, unknown, Route, Job, Flag, string, Access>;

/**
 * Compose an app from plugin values. Refuses, at compile time where the
 * types allow and here otherwise: a missing dependency, a duplicate plugin,
 * a service implemented twice, a cycle, and two plugins claiming one job,
 * flag, access entity, audit table, or migration folder.
 */
export function composeApp<
  Name extends string,
  Needed extends string,
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  ServiceName extends string = never,
  const Access extends readonly AccessContribution[] =
    readonly AccessContribution[],
>(
  // The tuple infers each plugin's contribution separately. The array
  // infers the shared route, job, flag, and dependency types.
  plugins: readonly Plugin<
    Name,
    Needed,
    unknown,
    Route,
    Job,
    Flag,
    ServiceName
  >[] & {
    readonly [Index in keyof Access]: {
      readonly contributes: { readonly access: readonly Access[Index][] };
    };
  },
  ...unmet: DependencyCheck<`plugin:${Name}` | `service:${ServiceName}`, Needed>
): ComposedApp<Route, Job, Flag, Access[number]> {
  if (unmet.length > 0) {
    throw new PluginCompositionError(unmet.join(", "));
  }
  const entries: readonly Plugin<
    Name,
    Needed,
    unknown,
    Route,
    Job,
    Flag,
    ServiceName,
    Access[number]
  >[] = plugins;
  return assembleApp<
    Route,
    Job,
    Flag,
    Access[number],
    (typeof entries)[number]
  >(entries, startPlugins);
}

/** Validate and aggregate the original plugin identities before exposing surfaces. */
export function assembleApp<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution,
  Entry extends ComposablePlugin<unknown, NamedJob, Flag, Access>,
>(
  entries: readonly Entry[],
  start: (ordered: readonly Entry[]) => Promise<RunningApp<Route, Job>>,
): ComposedApp<Route, Job, Flag, Access> {
  const ordered = orderPlugins(entries);
  refuseDeclaredDuplicates(ordered);
  return {
    plugins: ordered.map((plugin) => plugin.name),
    access: ordered.flatMap((plugin) => plugin.contributes.access),
    flags: ordered.flatMap((plugin) => plugin.contributes.flags),
    untrackedAuditTables: ordered.flatMap(
      (plugin) => plugin.contributes.untrackedTables,
    ),
    auditScopes: ordered.flatMap((plugin) => plugin.contributes.auditScopes),
    migrationSources: (workspaceRoot) =>
      migrationSourcesFor(ownedMigrationFolders(ordered), workspaceRoot),
    start: () => start(ordered),
  };
}

function ownedMigrationFolders(
  plugins: readonly ComposablePlugin<unknown, NamedJob, SluggedFlag>[],
): readonly OwnedMigrationFolder[] {
  return plugins.flatMap((plugin) =>
    plugin.contributes.migrations.map((folder) => ({
      ...folder,
      owner: plugin.name,
    })),
  );
}

function refuseDeclaredDuplicates(
  plugins: readonly ComposablePlugin<unknown, NamedJob, SluggedFlag>[],
): void {
  const claims = (
    keysOf: (plugin: (typeof plugins)[number]) => readonly string[],
  ) =>
    plugins.flatMap((plugin) =>
      keysOf(plugin).map((key) => ({ key, pluginName: plugin.name })),
    );
  refuseDuplicates(
    "access entity",
    claims((plugin) =>
      plugin.contributes.access.map((item) => item.entity.wireName),
    ),
  );
  refuseDuplicates(
    "feature flag",
    claims((plugin) => plugin.contributes.flags.map((flag) => flag.slug)),
  );
  refuseDuplicates(
    "audit table",
    claims((plugin) => [
      ...plugin.contributes.untrackedTables,
      ...plugin.contributes.auditScopes.map(({ table }) => table),
    ]),
  );
  refuseDuplicates(
    "migration folder",
    claims((plugin) =>
      plugin.contributes.migrations.map((folder) => folder.directory),
    ),
  );
}
