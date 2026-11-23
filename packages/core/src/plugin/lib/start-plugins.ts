import { CompositionRun, type Dependency } from "./dependency.js";
import type { NamedJob, StartedContributions } from "./plugin-contributions.js";
import {
  type PluginDisposalFailure,
  PluginStartError,
  PluginStopError,
} from "./plugin-errors.js";
import { refuseDuplicates } from "./refuse-duplicates.js";
import {
  EffectScope,
  type PluginScope,
  type ScopeLedger,
} from "./plugin-scope.js";

/** What starting reads from a plugin. */
export type StartablePlugin<Route, Job extends NamedJob> = {
  readonly name: string;
  readonly start: (
    run: CompositionRun,
    scope: PluginScope,
  ) => Promise<StartedContributions<Route, Job>>;
};

/** A started app. Hand `routes` and `jobs` to the host; call `stop` once done. */
export type RunningApp<Route, Job extends NamedJob> = {
  /** Every plugin's routes, in setup order. */
  readonly routes: readonly Route[];
  /** Every plugin's jobs, in setup order; names are unique. */
  readonly jobs: readonly Job[];
  /** What a plugin or service offers in this run. */
  readonly read: <Value>(dependency: Dependency<string, Value>) => Value;
  /** Each plugin's effect ledger, in setup order. */
  readonly effects: () => readonly ScopeLedger[];
  /**
   * Dispose every plugin's scope, last-started first. Every scope is
   * disposed even when one fails; failures throw `PluginStopError` at the
   * end. Calling it again returns the first call's promise.
   */
  readonly stop: () => Promise<void>;
};

type Started<Route, Job extends NamedJob> = {
  readonly name: string;
  readonly scope: EffectScope;
  readonly contributions: StartedContributions<Route, Job>;
};

/** Start plugins in the given order, rolling back if one fails. */
export async function startPlugins<Route, Job extends NamedJob>(
  ordered: readonly StartablePlugin<Route, Job>[],
): Promise<RunningApp<Route, Job>> {
  const run = new CompositionRun();
  const started: Started<Route, Job>[] = [];
  for (const plugin of ordered) {
    const scope = new EffectScope(plugin.name);
    try {
      const contributions = await plugin.start(run, scope);
      started.push({ name: plugin.name, scope, contributions });
    } catch (cause) {
      const failed = await scope.dispose();
      const rollback = await disposeNewestFirst(started);
      throw new PluginStartError(plugin.name, cause, [
        ...failed,
        ...rollback.flatMap((failure) => failure.errors),
      ]);
    }
  }
  await refuseDuplicateJobs(started);
  return runningApp(run, started);
}

/** Two plugins' jobs with one name: stop everything, then refuse. */
async function refuseDuplicateJobs(
  started: readonly Started<unknown, NamedJob>[],
): Promise<void> {
  try {
    refuseDuplicates(
      "job",
      started.flatMap((entry) =>
        entry.contributions.jobs.map((job) => ({
          key: job.name,
          pluginName: entry.name,
        })),
      ),
    );
  } catch (error) {
    await disposeNewestFirst(started);
    throw error;
  }
}

function runningApp<Route, Job extends NamedJob>(
  run: CompositionRun,
  started: readonly Started<Route, Job>[],
): RunningApp<Route, Job> {
  let stopping: Promise<void> | undefined;
  return {
    routes: started.flatMap((entry) => entry.contributions.routes),
    jobs: started.flatMap((entry) => entry.contributions.jobs),
    read: (dependency) => dependency.read(run),
    effects: () => started.map((entry) => entry.scope.ledger()),
    stop: () => {
      stopping ??= stopAll(started);
      return stopping;
    },
  };
}

async function stopAll(
  started: readonly Started<unknown, NamedJob>[],
): Promise<void> {
  const failures = await disposeNewestFirst(started);
  if (failures.length > 0) throw new PluginStopError(failures);
}

async function disposeNewestFirst(
  started: readonly Started<unknown, NamedJob>[],
): Promise<readonly PluginDisposalFailure[]> {
  const failures: PluginDisposalFailure[] = [];
  for (const entry of [...started].reverse()) {
    const errors = await entry.scope.dispose();
    if (errors.length > 0) failures.push({ pluginName: entry.name, errors });
  }
  return failures;
}
