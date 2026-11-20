/** Thrown by `composeApp` when the plugin list cannot form one app. */
export class PluginCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCompositionError";
  }
}

/**
 * Thrown by `start()` when a plugin's setup fails. Everything that had
 * already started was disposed first; `disposalErrors` holds any disposer
 * that failed during that rollback.
 */
export class PluginStartError extends Error {
  constructor(
    readonly pluginName: string,
    cause: unknown,
    readonly disposalErrors: readonly unknown[],
  ) {
    super(
      `plugin ${pluginName} failed to start; the plugins started before it were stopped${disposalErrors.length > 0 ? ` (${String(disposalErrors.length)} disposer(s) also failed)` : ""}`,
      { cause },
    );
    this.name = "PluginStartError";
  }
}

/** One plugin's failed disposers. */
export type PluginDisposalFailure = {
  readonly pluginName: string;
  readonly errors: readonly unknown[];
};

/**
 * Thrown by `stop()` after every plugin's scope has been disposed, when at
 * least one disposer failed. No disposer is skipped because another threw.
 */
export class PluginStopError extends AggregateError {
  constructor(readonly failures: readonly PluginDisposalFailure[]) {
    super(
      failures.flatMap((failure) => failure.errors),
      `plugin disposal failed in ${failures.map((failure) => failure.pluginName).join(", ")}`,
    );
    this.name = "PluginStopError";
  }
}
