import type { ServiceBinding } from "./define-service.js";
import { type AnyDependency, type CompositionRun, type Dependency, OfferedValues } from "./dependency.js";
import {
  type AccessContribution,
  type DeclaredContributions,
  declaredContributions,
  type NamedJob,
  type PluginContributions,
  type PluginRuntime,
  type SluggedFlag,
  type StartedContributions,
} from "./plugin-contributions.js";
import type { PluginScope } from "./plugin-scope.js";

/** What setup receives. */
export type PluginSetupContext<Declared extends AnyDependency> = {
  readonly scope: PluginScope;
  /**
   * The value a declared dependency offers. Only dependencies listed in
   * `requires` are accepted, by the compiler and again at runtime.
   */
  readonly use: <Value>(dependency: Dependency<Declared["dependencyName"], Value>) => Value;
};

export type PluginSpec<
  Name extends string,
  Requires extends readonly AnyDependency[],
  Provides,
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  ServiceName extends string,
  Access extends AccessContribution = AccessContribution,
> = {
  /** Unique in the app; lowercase words and dashes. */
  readonly name: Name;
  /** Plugins and services this plugin's setup uses; they start first. */
  readonly requires?: Requires;
  /** The service this plugin's `provides` value implements. */
  readonly implements?: ServiceBinding<ServiceName, Provides>;
  /** Declared contributions, readable without starting anything. */
  readonly contributes?: PluginContributions<Flag, Access>;
  readonly setup?: (
    context: PluginSetupContext<Requires[number]>,
  ) => PluginRuntime<Provides, Route, Job> | Promise<PluginRuntime<Provides, Route, Job>>;
};

/**
 * A plugin value: what `definePlugin` returns and what an app composes.
 * `start` is called by the composition, never by application code.
 */
export type Plugin<
  Name extends string,
  Need extends string,
  Provides,
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
  ServiceName extends string,
  Access extends AccessContribution = AccessContribution,
> = Dependency<`plugin:${Name}`, Provides> & {
  readonly kind: "plugin";
  readonly name: Name;
  readonly requires: readonly Dependency<Need, unknown>[];
  readonly implements: ServiceBinding<ServiceName, never> | undefined;
  readonly contributes: DeclaredContributions<Flag, Access>;
  readonly start: (run: CompositionRun, scope: PluginScope) => Promise<StartedContributions<Route, Job>>;
};

/** Any plugin, for code that only orders, starts, or reports. */
export type AnyPlugin = Plugin<string, string, unknown, unknown, NamedJob, SluggedFlag, string>;

const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Declare a plugin: the one value a plugin package exports. Contributions
 * that are plain data go in `contributes`; anything that needs a running
 * dependency is built in `setup`, which registers its effects on `scope`.
 */
export function definePlugin<
  const Name extends string,
  const Requires extends readonly AnyDependency[] = [],
  Provides = undefined,
  Route = never,
  Job extends NamedJob = never,
  Flag extends SluggedFlag = never,
  ServiceName extends string = never,
  Access extends AccessContribution = never,
>(
  spec: PluginSpec<Name, Requires, Provides, Route, Job, Flag, ServiceName, Access>,
): Plugin<Name, Requires[number]["dependencyName"], Provides, Route, Job, Flag, ServiceName, Access> {
  if (!PLUGIN_NAME.test(spec.name)) {
    throw new Error(`plugin name ${JSON.stringify(spec.name)} must be lowercase words joined by dashes`);
  }
  const offered = new OfferedValues<Provides>(`plugin ${spec.name}`);
  const dependencyName: `plugin:${Name}` = `plugin:${spec.name}`;
  return {
    kind: "plugin",
    name: spec.name,
    dependencyName,
    requires: spec.requires ?? [],
    implements: spec.implements,
    contributes: declaredContributions(spec.contributes),
    read: (run) => offered.read(run),
    start: (run, scope) => startPlugin(spec, { run, scope, offered }),
  };
}

type StartInput<Provides> = {
  readonly run: CompositionRun;
  readonly scope: PluginScope;
  readonly offered: OfferedValues<Provides>;
};

async function startPlugin<
  Requires extends readonly AnyDependency[],
  Provides,
  Route,
  Job extends NamedJob,
  ServiceName extends string,
>(
  spec: PluginSpec<string, Requires, Provides, Route, Job, SluggedFlag, ServiceName>,
  input: StartInput<Provides>,
): Promise<StartedContributions<Route, Job>> {
  if (spec.setup === undefined) return { routes: [], jobs: [] };
  const declared: readonly AnyDependency[] = spec.requires ?? [];
  function use<Value>(dependency: Dependency<string, Value>): Value {
    return readDeclared(spec.name, declared, dependency, input.run);
  }
  const runtime = await spec.setup({ scope: input.scope, use });
  const provides = runtime.provides;
  if (provides !== undefined) {
    input.offered.remember(input.run, provides);
    spec.implements?.bind(input.run, provides);
  } else if (spec.implements !== undefined) {
    throw new Error(
      `plugin ${spec.name} implements service ${spec.implements.name} but its setup returned no \`provides\``,
    );
  }
  return { routes: runtime.routes ?? [], jobs: runtime.jobs ?? [] };
}

function readDeclared<Value>(
  pluginName: string,
  declared: readonly AnyDependency[],
  dependency: Dependency<string, Value>,
  run: CompositionRun,
): Value {
  if (!declared.includes(dependency)) {
    throw new Error(
      `plugin ${pluginName} used ${dependency.kind} ${dependency.name}, which it does not list in \`requires\``,
    );
  }
  return dependency.read(run);
}
