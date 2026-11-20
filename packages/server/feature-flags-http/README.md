# `@dads-framework/feature-flags-http`

Serves `@dads-framework/feature-flags` through the HTTP kit: management
routes guarded by a permission the application names, the caller's effective
feature state, the public list, and the evaluator the kit runs once per
request.

## Try it

```ts
import { fromFixed } from "@dads-framework/http";
import {
  createFeatureFlagRoutes,
  FeatureFlagRequestEvaluator,
} from "@dads-framework/feature-flags-http";
import {
  CLIENT_FEATURE_STATE_HASH_HEADER,
  FEATURE_STATE_CONTEXT_HEADER,
  FEATURE_STATE_HASH_HEADER,
} from "@dads-framework/feature-flags";

const routes = createFeatureFlagRoutes({
  featureFlags: flags,
  manage: {
    kind: "permission",
    resourceType: "app/settings",
    permission: "manage_feature_flags",
    resourceId: fromFixed("main"),
  },
});

const featureState = {
  evaluator: new FeatureFlagRequestEvaluator(flags.effective, ({ context }) =>
    context === undefined ? null : { kind: "tenant", tenantId: context },
  ),
  hashHeader: FEATURE_STATE_HASH_HEADER,
  clientHashHeader: CLIENT_FEATURE_STATE_HASH_HEADER,
  contextHeader: FEATURE_STATE_CONTEXT_HEADER,
};
// registerRoutes(app, { routes, featureState, ... })
```

## Use it

- `createFeatureFlagRoutes({ featureFlags, manage, tag? })` returns the
  route group below.
- `FeatureFlagRequestEvaluator(effective, resolveContext)` is the HTTP kit's
  `FeatureStateRequestEvaluator`. `resolveContext` is where the application
  says which tenant a request acts in. Resolve it from what the session
  proves, not from a header alone, when tenants must not read each other's
  pilots.

## What it refuses to do

- It never answers a management route to a caller without the `manage`
  permission. The HTTP kit asks the application's `Authorization` first and
  answers a refusal with 404, the same as an unknown route.
- It never decides the tenant itself. A request the resolver answers `null`
  for carries no feature state.

## Contract

| Route                              | Access            | Answers                                                               |
| ---------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `GET /feature-flags`               | `manage`          | `FeatureFlagManagementList`                                           |
| `GET /feature-flags/:slug/history` | `manage`          | paged `FeatureFlagHistoryEntry`                                       |
| `POST /feature-flags`              | `manage`          | `{ states: FeatureFlagState[] }`                                      |
| `GET /feature-state`               | signed-in session | `EffectiveFeatureState`; the platform answer when no context resolves |
| `GET /feature-state/public`        | public            | `PublicFeatureState`                                                  |

Errors are the core package's, mapped by the HTTP kit: conflict 409,
not-found 404, validation 400.

`createFeatureFlagRoutesPlugin()` serves the configured public flag list.
Supply `{ manage }` to select the management routes and the signed-in effective
state route as well. Add the plugin only to the API route list that should
receive those operations. The selected API needs `featureFlagsService`.
