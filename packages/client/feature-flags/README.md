# `@dads-framework/client-feature-flags`

Feature state in the browser: a runtime that keeps each context's flags and
hash apart, and React hooks that read it. The application supplies the loader
and reports response hashes from its own transport.

## Try it

```tsx
import {
  FeatureStateRuntime,
  useFeatureEnabled,
} from "@dads-framework/client-feature-flags";

const runtime = new FeatureStateRuntime(async (contextKey) => {
  const response = await fetch("/api/feature-state", {
    headers: { "x-feature-state-context": contextKey },
  });
  return (await response.json()).data;
});

function ExportButton({ tenantId }: { tenantId: string }) {
  const enabled = useFeatureEnabled(
    runtime,
    tenantId,
    "billing.invoices.bulk-export",
  );
  return enabled ? <button>Export</button> : null;
}
```

## Use it

- `new FeatureStateRuntime(load)`: `activate(contextKey)`, `hydrate`,
  `snapshot`, `isEnabled`, `subscribe`, `refreshActiveContext`.
- `observeResponse({ contextKey, stateHash })`: call it with the
  `x-feature-state-hash` of each response; a new hash refreshes that context
  once.
- `hashFor(contextKey)`: send it as `x-client-feature-state-hash` so the
  server can refuse a write made against stale flags.
- `useActivateFeatureState`, `useFeatureState`, `useFeatureEnabled`: the
  React side, through `useSyncExternalStore`.

## What it refuses to do

- It never reads a context as on before its flags load: unhydrated means off.
- It never turns flags off because a refresh failed. It keeps the last known
  ones and sets `refreshFailed`.
- It never mixes contexts. Each context key has its own flags and hash.
- It is a display gate. The server's own check is the wall.

## Contract

| Shape                  | Fields                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `FeatureStateSnapshot` | `contextKey`, `features`, `stateHash`, `hydrated`, `refreshFailed` |
| `FeatureStateLoader`   | `(contextKey) => Promise<EffectiveFeatureState>`                   |
