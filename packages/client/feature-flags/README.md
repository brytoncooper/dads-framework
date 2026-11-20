# `@dads-framework/client-feature-flags`

Feature state in the browser: a runtime that keeps each context's flags and
hash apart, and React hooks that read it. The application supplies the loader
and reports response hashes from its own transport.

## Try it

In a React 19 TypeScript app, install the client and the shared state schema.

```sh
npm install @dads-framework/client-feature-flags @dads-framework/feature-flags react@^19
```

Render `<ExportAvailability tenantId="north" />` from your app. The sample loader
gives one tenant the export flag and returns an empty list for other tenants.

<!-- dads:check-example -->

```tsx
import {
  FeatureStateRuntime,
  useActivateFeatureState,
  useFeatureEnabled,
} from "@dads-framework/client-feature-flags";
import { effectiveFeatureStateSchema } from "@dads-framework/feature-flags/contract";

const exportFeature = "billing.invoices.bulk-export";
const runtime = new FeatureStateRuntime(async (tenantId) =>
  effectiveFeatureStateSchema.parse({
    features: tenantId === "north" ? [exportFeature] : [],
    stateHash: tenantId === "north" ? "north-v1" : "other-v1",
  }),
);

export function ExportAvailability({ tenantId }: { tenantId: string }) {
  useActivateFeatureState(runtime, tenantId);
  const enabled = useFeatureEnabled(runtime, tenantId, exportFeature);
  return <p>{enabled ? "Bulk export available" : "Bulk export unavailable"}</p>;
}
```

After the loader resolves, `north` shows **Bulk export available**. Switch the
prop to `south` to see **Bulk export unavailable**. In the app, read the
effective state from your authorized feature-state endpoint and enforce the
flag and permission on the export endpoint.

The [runtime tests](src/lib/feature-state-runtime.test.ts) use a loader with
two tenants to check that their feature lists and state hashes stay separate.

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
