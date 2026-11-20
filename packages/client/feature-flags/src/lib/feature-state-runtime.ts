import type { EffectiveFeatureState } from "@dads-framework/feature-flags/contract";

/** What a component reads for one context. Unhydrated means every feature is off. */
export type FeatureStateSnapshot = {
  readonly contextKey: string;
  readonly features: readonly string[];
  readonly stateHash: string | undefined;
  readonly hydrated: boolean;
  readonly refreshFailed: boolean;
};

/** The application's read of one context's effective state, usually `GET /feature-state`. */
export type FeatureStateLoader = (
  contextKey: string,
) => Promise<EffectiveFeatureState>;

type Listener = () => void;

/**
 * Context-keyed feature state for the browser. A context key is whatever the
 * application sends as its feature-state context header (a tenant id, or
 * "platform"). Each context keeps its own flags and hash; the application's
 * transport reports response hashes with `observeResponse` and sends
 * `hashFor` back on writes.
 */
export class FeatureStateRuntime {
  private readonly records = new Map<string, FeatureStateSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<Listener>();
  private activeContextKey: string | undefined;

  constructor(private readonly load: FeatureStateLoader) {}

  /** Makes `contextKey` the one focus and hash drift refresh, and reads it. */
  activate(contextKey: string): void {
    this.activeContextKey = contextKey;
    void this.hydrate(contextKey);
  }

  /** Reads one context's flags; concurrent calls for the same context share one read. */
  async hydrate(contextKey: string): Promise<void> {
    const existing = this.inFlight.get(contextKey);
    if (existing !== undefined) return existing;
    const refresh = this.refresh(contextKey);
    this.inFlight.set(contextKey, refresh);
    try {
      await refresh;
    } finally {
      this.inFlight.delete(contextKey);
    }
  }

  /** A response carried this context's current hash; a different one means the flags moved. */
  observeResponse(input: {
    readonly contextKey: string;
    readonly stateHash: string | null;
  }): void {
    if (input.stateHash === null || input.stateHash.length === 0) return;
    if (this.records.get(input.contextKey)?.stateHash === input.stateHash) {
      return;
    }
    void this.hydrate(input.contextKey);
  }

  /** The hash to send back with a request in this context, when one is known. */
  hashFor(contextKey: string): string | undefined {
    return this.records.get(contextKey)?.stateHash;
  }

  /** The same object until this context's state changes, as `useSyncExternalStore` needs. */
  snapshot(contextKey: string): FeatureStateSnapshot {
    const record = this.records.get(contextKey);
    if (record !== undefined) return record;
    const initial: FeatureStateSnapshot = {
      contextKey,
      features: [],
      stateHash: undefined,
      hydrated: false,
      refreshFailed: false,
    };
    this.records.set(contextKey, initial);
    return initial;
  }

  isEnabled(contextKey: string, slug: string): boolean {
    return this.snapshot(contextKey).features.includes(slug);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-reads the active context, for a window regaining focus. */
  refreshActiveContext(): void {
    if (this.activeContextKey !== undefined) {
      void this.hydrate(this.activeContextKey);
    }
  }

  private async refresh(contextKey: string): Promise<void> {
    try {
      const state = await this.load(contextKey);
      this.records.set(contextKey, {
        contextKey,
        features: state.features,
        stateHash: state.stateHash,
        hydrated: true,
        refreshFailed: false,
      });
    } catch {
      // A failed refresh keeps the last known flags rather than turning them off.
      const previous = this.snapshot(contextKey);
      this.records.set(contextKey, { ...previous, refreshFailed: true });
    } finally {
      for (const listener of this.listeners) listener();
    }
  }
}
