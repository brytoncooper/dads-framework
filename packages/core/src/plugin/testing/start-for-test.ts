import type { ComposedApp } from "../lib/compose-app.js";
import type { NamedJob, SluggedFlag } from "../lib/plugin-contributions.js";
import type { RunningApp } from "../lib/start-plugins.js";

export type StartForTestOptions = {
  /**
   * Counts live resources outside the scope ledger, read before start and
   * after stop: `() => vi.getTimerCount()` under fake timers, or
   * `() => process.getActiveResourcesInfo().length`. A plugin that starts
   * something without registering it on its scope shows up here.
   */
  readonly leakProbe?: () => number;
};

export type PluginTestHarness<Route, Job extends NamedJob> = {
  readonly running: RunningApp<Route, Job>;
  /**
   * Stop the app and refuse anything left behind: a failed disposer (the
   * `PluginStopError` propagates), an effect still in a plugin's ledger, or
   * a leak probe reading higher than before start.
   */
  readonly stopCleanly: () => Promise<void>;
};

/** Thrown by `stopCleanly` when a stopped app left something running. */
export class PluginLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLeakError";
  }
}

/** Start a composed plugin set for one test. */
export async function startForTest<
  Route,
  Job extends NamedJob,
  Flag extends SluggedFlag,
>(
  app: ComposedApp<Route, Job, Flag>,
  options: StartForTestOptions = {},
): Promise<PluginTestHarness<Route, Job>> {
  const before = options.leakProbe?.();
  const running = await app.start();
  return {
    running,
    stopCleanly: async () => {
      await running.stop();
      assertNoLiveEffects(running);
      const after = options.leakProbe?.();
      if (before !== undefined && after !== undefined && after > before) {
        throw new PluginLeakError(
          `the leak probe read ${String(before)} before start and ${String(after)} after stop`,
        );
      }
    },
  };
}

/** Refuse a stopped app whose plugins still hold live effects. */
export function assertNoLiveEffects(
  running: RunningApp<unknown, NamedJob>,
): void {
  const leftover = running
    .effects()
    .filter((ledger) => !ledger.disposed || ledger.live > 0);
  if (leftover.length > 0) {
    throw new PluginLeakError(
      `plugins still hold effects after stop: ${leftover
        .map((ledger) => `${ledger.pluginName} (${String(ledger.live)} live)`)
        .join(", ")}`,
    );
  }
}
