import { assembleApp, type ComposedApp, type DependencyCheck } from "./compose-app.js";
import type { Plugin } from "./define-plugin.js";
import type { AccessContribution, NamedJob, SluggedFlag, StartedContributions } from "./plugin-contributions.js";
import { PluginCompositionError } from "./plugin-errors.js";
import { startPlugins, type StartablePlugin } from "./start-plugins.js";

/** One API's explicit selection. Only listed routes and jobs reach the host. */
export type ApiSelection<
  Name extends string,
  Needed extends string,
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  ServiceName extends string,
  Access extends AccessContribution,
> = {
  readonly services: readonly Plugin<Name, Needed, unknown, unknown, NamedJob, Flag, ServiceName, Access>[];
  readonly routes: readonly Plugin<Name, Needed, unknown, Route, NamedJob, Flag, ServiceName, Access>[];
  readonly jobs: readonly Plugin<Name, Needed, unknown, unknown, Job, Flag, ServiceName, Access>[];
};

/** Compose one named API from its service, route, and job selections. */
export function composeApi<
  const ApiName extends string,
  Name extends string,
  Needed extends string,
  Route,
  Job extends NamedJob = never,
  Flag extends SluggedFlag = SluggedFlag,
  ServiceName extends string = never,
  Access extends AccessContribution = AccessContribution,
>(
  name: ApiName,
  selection: ApiSelection<Name, Needed, Route, Job, Flag, ServiceName, Access>,
  ...unmet: DependencyCheck<`plugin:${Name}` | `service:${ServiceName}`, Needed>
): ComposedApp<Route, Job, Flag, Access> & { readonly name: ApiName } {
  try {
    if (unmet.length > 0) throw new PluginCompositionError(unmet.join(", "));
    const composed = assembleApiSelection(selection);
    return { name, ...composed };
  } catch (error) {
    if (error instanceof PluginCompositionError) {
      throw new PluginCompositionError(`API ${name}: ${error.message}`);
    }
    throw error;
  }
}

/** True when a route-slot and job-slot reference point to the exact same plugin instance. */
function samePlugin<Route, Job extends NamedJob>(
  routePlugin: StartablePlugin<Route, NamedJob>,
  jobPlugin: StartablePlugin<unknown, Job>,
): jobPlugin is StartablePlugin<Route, Job> {
  return Object.is(routePlugin, jobPlugin);
}

/** Assemble a service/route/job selection without requiring compile-time dependency proofs. */
export function assembleApiSelection<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  Access extends AccessContribution,
>(selection: {
  readonly services: readonly Plugin<string, string, unknown, unknown, NamedJob, Flag, string, Access>[];
  readonly routes: readonly Plugin<string, string, unknown, Route, NamedJob, Flag, string, Access>[];
  readonly jobs: readonly Plugin<string, string, unknown, unknown, Job, Flag, string, Access>[];
}): ComposedApp<Route, Job, Flag, Access> {
  const entries: Plugin<string, string, unknown, unknown, NamedJob, Flag, string, Access>[] = [];
  const seen = new Set<Plugin<string, string, unknown, unknown, NamedJob, Flag, string, Access>>();
  const routeByName = new Map<string, StartablePlugin<Route, NamedJob>>();
  const jobByName = new Map<string, StartablePlugin<unknown, Job>>();
  const plan = new Map<string, StartablePlugin<Route, Job>>();

  const addEntry = (plugin: Plugin<string, string, unknown, unknown, NamedJob, Flag, string, Access>): void => {
    if (!seen.has(plugin)) {
      seen.add(plugin);
      entries.push(plugin);
    }
  };

  for (const plugin of selection.services) {
    addEntry(plugin);
    plan.set(
      plugin.name,
      expose(plugin, () => ({ routes: [], jobs: [] })),
    );
  }
  for (const plugin of selection.routes) {
    addEntry(plugin);
    routeByName.set(plugin.name, plugin);
    plan.set(
      plugin.name,
      expose(plugin, ({ routes }) => ({ routes, jobs: [] })),
    );
  }
  for (const plugin of selection.jobs) {
    addEntry(plugin);
    jobByName.set(plugin.name, plugin);
    const routePlugin = routeByName.get(plugin.name);
    if (routePlugin !== undefined && samePlugin(routePlugin, plugin)) {
      plan.set(
        plugin.name,
        expose(plugin, ({ routes, jobs }) => ({ routes, jobs })),
      );
    } else {
      plan.set(
        plugin.name,
        expose(plugin, ({ jobs }) => ({ routes: [], jobs })),
      );
    }
  }

  return assembleApp<Route, Job, Flag, Access, (typeof entries)[number]>(entries, (ordered) =>
    startPlugins(
      ordered.map(({ name: pluginName }) => {
        const startable = plan.get(pluginName);
        if (startable === undefined) throw new Error(`No start plan for ${pluginName}`);
        return startable;
      }),
    ),
  );
}

/** Project one setup's result without replacing its dependency token. */
function expose<InputRoute, InputJob extends NamedJob, Route, Job extends NamedJob>(
  plugin: StartablePlugin<InputRoute, InputJob>,
  select: (started: StartedContributions<InputRoute, InputJob>) => StartedContributions<Route, Job>,
): StartablePlugin<Route, Job> {
  return {
    name: plugin.name,
    start: async (run, scope) => select(await plugin.start(run, scope)),
  };
}
