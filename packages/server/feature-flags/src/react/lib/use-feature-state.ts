import { useEffect, useSyncExternalStore } from "react";

import type { FeatureStateRuntime, FeatureStateSnapshot } from "./feature-state-runtime.js";

/** Reads `contextKey`'s flags when a route enters it. */
export function useActivateFeatureState(runtime: FeatureStateRuntime, contextKey: string): void {
  useEffect(() => {
    runtime.activate(contextKey);
  }, [runtime, contextKey]);
}

/** Reactive feature state for one context. */
export function useFeatureState(runtime: FeatureStateRuntime, contextKey: string): FeatureStateSnapshot {
  return useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.snapshot(contextKey),
    () => runtime.snapshot(contextKey),
  );
}

/**
 * Whether one feature is on in one context. A display gate only: the server's
 * own check is the wall.
 */
export function useFeatureEnabled(runtime: FeatureStateRuntime, contextKey: string, slug: string): boolean {
  return useFeatureState(runtime, contextKey).features.includes(slug);
}
