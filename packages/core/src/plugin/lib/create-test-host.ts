import { assembleApiSelection } from "./compose-api.js";
import { assembleApp, type ComposedApp } from "./compose-app.js";
import type { AnyPlugin, Plugin } from "./define-plugin.js";
import type { Service } from "./define-service.js";
import type { Dependency } from "./dependency.js";
import type { AccessContribution, AuditScopeContribution, NamedJob, SluggedFlag } from "./plugin-contributions.js";
import type { ScopeLedger } from "./plugin-scope.js";
import { providePlugin } from "./provide-plugin.js";
import { startPlugins } from "./start-plugins.js";

/** A plugin implementing a service for test substitution, carrying no routes, jobs, flags, or access. */
export type TestServiceOverride = Plugin<string, string, unknown, never, never, never, string, never>;

/** Started plugin composition wrapped for tests and deterministic simulation. */
export type TestHost<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution = AccessContribution,
> = {
  /** Plugin names in setup order. */
  readonly plugins: readonly string[];
  /** Every active plugin's routes, in setup order. */
  readonly routes: readonly Route[];
  /** Every active plugin's jobs, in setup order. */
  readonly jobs: readonly Job[];
  /** Declared feature flags across active plugins. */
  readonly flags: readonly Flag[];
  /** Declared access definitions across active plugins. */
  readonly access: readonly Access[];
  /** Declared audit-untracked tables across active plugins. */
  readonly untrackedAuditTables: readonly string[];
  /** Declared audit scopes across active plugins. */
  readonly auditScopes: readonly AuditScopeContribution[];
  /** Read the value offered by a plugin or service token in this run. */
  readonly read: <Value>(dependency: Dependency<string, Value>) => Value;
  /** Each plugin's effect ledger, in setup order. */
  readonly effects: () => readonly ScopeLedger[];
  /** Dispose every plugin's scope, last-started first. Idempotent. */
  readonly stop: () => Promise<void>;
};

export type CreateTestHostPluginsOptions<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution,
> = {
  readonly plugins: readonly Plugin<string, string, unknown, Route, Job, Flag, string, Access>[];
  readonly overrides?: readonly TestServiceOverride[];
};

export type CreateTestHostSelectionOptions<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution,
> = {
  readonly services?: readonly Plugin<string, string, unknown, unknown, NamedJob, Flag, string, Access>[];
  readonly routes?: readonly Plugin<string, string, unknown, Route, NamedJob, Flag, string, Access>[];
  readonly jobs?: readonly Plugin<string, string, unknown, unknown, Job, Flag, string, Access>[];
  readonly overrides?: readonly TestServiceOverride[];
};

/**
 * Create a service-providing plugin for tests with full type safety.
 * Pass it to `composeApp(...)` directly or to `createTestHost({ plugins, overrides })`
 * to replace an existing implementation of `service`.
 */
export function overrideService<const ServiceName extends string, Value, Provided extends Value = Value>(
  service: Service<ServiceName, Value>,
  value: Provided,
): Plugin<`override-${ServiceName}`, never, Provided, never, never, never, ServiceName, never>;
export function overrideService<
  const ServiceName extends string,
  Value,
  const PluginName extends string,
  Provided extends Value = Value,
>(
  service: Service<ServiceName, Value>,
  value: Provided,
  pluginName: PluginName,
): Plugin<PluginName, never, Provided, never, never, never, ServiceName, never>;
export function overrideService<const ServiceName extends string, Value, Provided extends Value = Value>(
  service: Service<ServiceName, Value>,
  value: Provided,
  pluginName?: string,
): Plugin<string, never, Provided, never, never, never, ServiceName, never> {
  const name = pluginName ?? `override-${service.name}`;
  return providePlugin(name, service, () => value);
}

/** Start an already composed app as a test host with `read`, metadata, and idempotent `stop()`. */
export async function startTestHost<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution = AccessContribution,
>(app: ComposedApp<Route, Job, Flag, Access>): Promise<TestHost<Route, Job, Flag, Access>> {
  const running = await app.start();
  return {
    plugins: app.plugins,
    routes: running.routes,
    jobs: running.jobs,
    flags: app.flags,
    access: app.access,
    untrackedAuditTables: app.untrackedAuditTables,
    auditScopes: app.auditScopes,
    read: running.read,
    effects: running.effects,
    stop: running.stop,
  };
}

/**
 * Compose and start plugins for a test or simulation run, substituting any
 * service providers listed in `overrides` before starting.
 */
export async function createTestHost<
  Route = never,
  Job extends NamedJob = never,
  Flag extends SluggedFlag = never,
  Access extends AccessContribution = never,
>(
  options:
    CreateTestHostPluginsOptions<Route, Job, Flag, Access> | CreateTestHostSelectionOptions<Route, Job, Flag, Access>,
): Promise<TestHost<Route, Job, Flag, Access>> {
  if ("plugins" in options) {
    const merged = mergeOverrides(options.plugins, options.overrides ?? []);
    const composed = assembleApp<Route, Job, Flag, Access, (typeof merged)[number]>(merged, startPlugins);
    return startTestHost(composed);
  }
  const overrides = options.overrides ?? [];
  const overridden = collectOverridden(overrides);
  const composed = assembleApiSelection({
    services: [...filterOverridden(options.services ?? [], overridden), ...overrides],
    routes: filterOverridden(options.routes ?? [], overridden),
    jobs: filterOverridden(options.jobs ?? [], overridden),
  });
  return startTestHost(composed);
}

type OverriddenTargets = {
  readonly services: ReadonlySet<object>;
  readonly names: ReadonlySet<string>;
};

function collectOverridden(overrides: readonly TestServiceOverride[]): OverriddenTargets {
  const services = new Set<object>();
  const names = new Set<string>();
  for (const override of overrides) {
    names.add(override.name);
    if (override.implements !== undefined) {
      services.add(override.implements);
    }
  }
  return { services, names };
}

function filterOverridden<Entry extends AnyPlugin>(
  plugins: readonly Entry[],
  overridden: OverriddenTargets,
): readonly Entry[] {
  if (overridden.names.size === 0 && overridden.services.size === 0) return plugins;
  return plugins.filter(
    (plugin) =>
      !overridden.names.has(plugin.name) &&
      (plugin.implements === undefined || !overridden.services.has(plugin.implements)),
  );
}

function mergeOverrides<Entry extends AnyPlugin>(
  plugins: readonly Entry[],
  overrides: readonly TestServiceOverride[],
): readonly (Entry | TestServiceOverride)[] {
  if (overrides.length === 0) return plugins;
  return [...filterOverridden(plugins, collectOverridden(overrides)), ...overrides];
}
