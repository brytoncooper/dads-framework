# `@dads-framework/feature-flags-http`

Serves `@dads-framework/feature-flags` through the HTTP kit: management
routes guarded by a permission the application names, the caller's effective
feature state, the public list, and the evaluator the kit runs once per
request.

## Try it

Install the flag kit and its HTTP binding.

```sh
npm install @dads-framework/feature-flags @dads-framework/feature-flags-http @dads-framework/http
```

Save as `flag-routes.mts` and run `node flag-routes.mts` with Node.js 22.18 or
newer. The test harness runs requests in process and denies all permission
checks by default.

<!-- dads:check-example -->

```ts
import { composeFeatureFlags } from "@dads-framework/feature-flags";
import {
  FakeTenantDirectory,
  featureFlagDefinitionFactory,
  FixedClock,
  InMemoryFeatureFlagStore,
} from "@dads-framework/feature-flags/testing";
import { createFeatureFlagRoutes } from "@dads-framework/feature-flags-http";
import { fromFixed } from "@dads-framework/http";
import {
  buildTestApp,
  TEST_SUBJECT_HEADER,
} from "@dads-framework/http/testing";

const exportFlag = featureFlagDefinitionFactory({ slug: "orders.export" });
const flags = composeFeatureFlags({
  definitions: [exportFlag],
  publicSlugs: [exportFlag.slug],
  store: new InMemoryFeatureFlagStore(),
  tenants: new FakeTenantDirectory(),
  clock: new FixedClock(new Date("2026-01-01T00:00:00Z")),
});
await flags.update.execute({
  actorId: "example-operator",
  request: {
    changes: [{ slug: exportFlag.slug, expectedRevision: 0, mode: "EVERYONE" }],
  },
});

const app = await buildTestApp({
  routes: createFeatureFlagRoutes({
    featureFlags: flags,
    manage: {
      kind: "permission",
      resourceType: "app/settings",
      permission: "manage_feature_flags",
      resourceId: fromFixed("main"),
    },
  }),
});
try {
  const publicState = await app.inject({
    method: "GET",
    url: "/feature-state/public",
  });
  console.log(publicState.statusCode, publicState.body);

  const management = await app.inject({
    method: "GET",
    url: "/feature-flags",
    headers: { [TEST_SUBJECT_HEADER]: "example-user" },
  });
  console.log(management.statusCode);
} finally {
  await app.close();
}
```

The anonymous public request returns `200` with `orders.export` in
`data.features`. The signed-in caller has no management permission, so the
second request returns `404`.

The repo-only [`src/lib/feature-flag-routes.test.ts`](src/lib/feature-flag-routes.test.ts) mounts these
routes and checks public reads and management access. The generated starter
wires the package’s request evaluator in [`assembly/feature-previews.ts`](../../../apps/kit-workbench/assembly/feature-previews.ts).

## Use it

- `createFeatureFlagRoutes({ featureFlags, manage, tag? })` returns the
  route group below.
- `FeatureFlagRequestEvaluator(effective, resolveContext)` is the HTTP kit's
  `FeatureStateRequestEvaluator`. `resolveContext` is where the application
  says which tenant a request acts in. Resolve it from what the session
  proves, not from a header alone, when tenants must not read each other's
  pilots.

### Scoped previews

Set `readPreview: readFeatureFlagPreview` when composing the flags. Set
`featureState.preview.resolver` to `createFeatureFlagPreviewResolver` and
choose the request and dropped-response headers in `featureState.preview`.
Use the composed flags’ definitions in the preview resolver and share
`resolveContext` with `FeatureFlagRequestEvaluator`.

The host supplies `findPreview(previewId)` to look up a typed record with
`owner`, `context`, `feature`, `active`, `allowsWrites` and `expiresAt`.
The host issues and revokes those records separately from rollout settings.
Its `canPreview({ subject, context, feature })` verifies current preview
permission, including the caller's relationship to the selected tenant. A
context header is only a hint for that check. The resolver also checks the
record's owner, context, expiry and flag definition before applying it.
Requests with a valid preview receive a private, non-cacheable response.

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
