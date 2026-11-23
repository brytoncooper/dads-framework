import type { AnyDependency } from "./dependency.js";
import { PluginCompositionError } from "./plugin-errors.js";

/** What ordering reads from a plugin. */
export type OrderablePlugin = AnyDependency & {
  readonly requires: readonly AnyDependency[];
  /** The service value this plugin implements; matched by identity. */
  readonly implements: { readonly name: string } | undefined;
};

/**
 * Setup order: every plugin after what it requires, otherwise in the order
 * the app listed them. Refuses duplicate names, a dependency no plugin in
 * the list offers, a service two plugins implement, and a cycle.
 */
export function orderPlugins<Entry extends OrderablePlugin>(
  plugins: readonly Entry[],
): readonly Entry[] {
  refuseDuplicateNames(plugins);
  const providers = providerIndex(plugins);
  const prerequisites = plugins.map((plugin) =>
    plugin.requires.map((dependency) =>
      providerOf(plugin, dependency, providers),
    ),
  );
  return topologicalOrder(plugins, prerequisites);
}

function refuseDuplicateNames(plugins: readonly OrderablePlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      throw new PluginCompositionError(
        `plugin ${plugin.name} is listed more than once`,
      );
    }
    seen.add(plugin.name);
  }
}

/** Each offered dependency value, mapped to the index of the plugin offering it. */
function providerIndex(
  plugins: readonly OrderablePlugin[],
): ReadonlyMap<object, number> {
  const providers = new Map<object, number>();
  plugins.forEach((plugin, index) => {
    providers.set(plugin, index);
    const service = plugin.implements;
    if (service === undefined) return;
    const existing = providers.get(service);
    if (existing !== undefined) {
      throw new PluginCompositionError(
        `service ${service.name} is implemented by both ${plugins[existing]?.name ?? "?"} and ${plugin.name}`,
      );
    }
    providers.set(service, index);
  });
  return providers;
}

function providerOf(
  plugin: OrderablePlugin,
  dependency: AnyDependency,
  providers: ReadonlyMap<object, number>,
): number {
  const index = providers.get(dependency);
  if (index !== undefined) return index;
  const missing =
    dependency.kind === "plugin"
      ? `plugin ${dependency.name}, which is not in the composition (or a different value with that name is)`
      : `service ${dependency.name}, which no plugin in the composition implements`;
  throw new PluginCompositionError(`plugin ${plugin.name} requires ${missing}`);
}

/** Kahn's algorithm, always taking the earliest-listed ready plugin. */
function topologicalOrder<Entry extends OrderablePlugin>(
  plugins: readonly Entry[],
  prerequisites: readonly (readonly number[])[],
): readonly Entry[] {
  const placed = new Set<number>();
  const ordered: Entry[] = [];
  while (ordered.length < plugins.length) {
    const next = plugins.findIndex(
      (_plugin, index) =>
        !placed.has(index) &&
        (prerequisites[index] ?? []).every((required) => placed.has(required)),
    );
    const plugin = plugins[next];
    if (plugin === undefined) throw cycleError(plugins, placed);
    placed.add(next);
    ordered.push(plugin);
  }
  return ordered;
}

function cycleError(
  plugins: readonly OrderablePlugin[],
  placed: ReadonlySet<number>,
): PluginCompositionError {
  const stuck = plugins
    .filter((_plugin, index) => !placed.has(index))
    .map((plugin) => plugin.name);
  return new PluginCompositionError(
    `plugins ${stuck.join(", ")} require each other in a cycle; no setup order exists`,
  );
}
