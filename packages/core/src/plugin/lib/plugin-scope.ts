/**
 * Every effect a plugin starts — a timer, a worker, a subscription, a
 * listener — is registered against the plugin's scope and disposed with it.
 * Nothing a plugin starts outlives `stop()`, and a test that composes a
 * plugin set can prove it.
 */

/** Undo one effect. May be async; the scope awaits it. */
export type Disposer = () => void | Promise<void>;

/** What a plugin's setup receives to register its effects. */
export type PluginScope = {
  readonly pluginName: string;
  /** Aborted when disposal begins: pass it to listeners, fetches, and loops. */
  readonly signal: AbortSignal;
  /** Run `dispose` when the scope closes. */
  readonly onDispose: (dispose: Disposer) => void;
  /**
   * Start an effect now and register what undoes it. The returned function
   * ends the effect early and removes it from the ledger.
   */
  readonly effect: (start: () => Disposer) => () => Promise<void>;
  /** A repeating timer, cleared on disposal. */
  readonly interval: (callback: () => void, everyMs: number) => void;
  /** A one-shot timer, cleared on disposal if it has not fired. */
  readonly timeout: (callback: () => void, afterMs: number) => void;
};

/** Effects a scope has started and not yet undone. */
export type ScopeLedger = {
  readonly pluginName: string;
  readonly registered: number;
  readonly live: number;
  readonly disposed: boolean;
};

/** Thrown when a plugin registers an effect after its scope has closed. */
export class PluginScopeClosedError extends Error {
  constructor(pluginName: string) {
    super(
      `plugin ${pluginName} registered an effect after its scope was disposed; the effect was not started`,
    );
    this.name = "PluginScopeClosedError";
  }
}

type LedgerEntry = { readonly dispose: Disposer };

/**
 * The scope behind `PluginScope`. Only the composition disposes it: setup
 * sees the narrower type, so a plugin cannot end its own lifetime.
 */
export class EffectScope implements PluginScope {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly entries = new Set<LedgerEntry>();
  private registeredCount = 0;
  private disposal: Promise<readonly unknown[]> | undefined;

  constructor(readonly pluginName: string) {
    this.signal = this.controller.signal;
  }

  readonly onDispose = (dispose: Disposer): void => {
    this.register(dispose);
  };

  readonly effect = (start: () => Disposer): (() => Promise<void>) => {
    this.refuseWhenClosed();
    const entry = this.register(start());
    return async () => {
      if (this.entries.delete(entry)) await entry.dispose();
    };
  };

  readonly interval = (callback: () => void, everyMs: number): void => {
    this.effect(() => {
      const handle = setInterval(callback, everyMs);
      return () => {
        clearInterval(handle);
      };
    });
  };

  readonly timeout = (callback: () => void, afterMs: number): void => {
    const release = this.effect(() => {
      const handle = setTimeout(() => {
        void release();
        callback();
      }, afterMs);
      return () => {
        clearTimeout(handle);
      };
    });
  };

  ledger(): ScopeLedger {
    return {
      pluginName: this.pluginName,
      registered: this.registeredCount,
      live: this.entries.size,
      disposed: this.disposal !== undefined,
    };
  }

  /**
   * Abort the signal, then undo every live effect, newest first. Every
   * disposer runs even when an earlier one throws; the errors are returned,
   * not thrown. Calling it again returns the first call's result.
   */
  dispose(): Promise<readonly unknown[]> {
    this.disposal ??= this.disposeEntries();
    return this.disposal;
  }

  private async disposeEntries(): Promise<readonly unknown[]> {
    this.controller.abort();
    const newestFirst = [...this.entries].reverse();
    this.entries.clear();
    const errors: unknown[] = [];
    for (const entry of newestFirst) {
      try {
        await entry.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private register(dispose: Disposer): LedgerEntry {
    this.refuseWhenClosed();
    const entry = { dispose };
    this.entries.add(entry);
    this.registeredCount += 1;
    return entry;
  }

  private refuseWhenClosed(): void {
    if (this.disposal !== undefined) {
      throw new PluginScopeClosedError(this.pluginName);
    }
  }
}
