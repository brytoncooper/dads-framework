# Preview Notes export availability for one account

## How the starter implements it

[domains/notes/server/flags.ts](../domains/notes/server/flags.ts) declares
`notes.export`. The customer API configures a preview in
[assembly/feature-previews.ts](../assembly/feature-previews.ts), scoped to an
account and tenant. The record can only affect read requests. At request time
the resolver reads the tenant from the route, matches the token digest, and
rechecks the caller's workspace view permission.

<!-- dads:excerpt {"path":"assembly/feature-previews.ts","language":"ts","from":"  const record: FeatureFlagPreviewRecord = {","through":"    expiresAt: configuration.expiresAt,"} -->

<!-- dads:excerpt {"path":"assembly/feature-previews.ts","language":"ts","from":"        canPreview: ({ subject, context }) =>","through":"      }),"} -->

## Try it

Run the feature preview test from the generated project:

```sh
npm test -- tests/feature-previews.test.ts
```

[The test](../tests/feature-previews.test.ts) starts with the flag off.
An account sends a preview token before it has workspace membership.
The response shows no enabled flags and includes
`x-feature-preview-dropped: 1`. Give the same account membership and the
same request returns `["notes.export"]`. The token still gets dropped when
the request targets a different workspace.

In a running app, the customer API reads `DADS_FEATURE_PREVIEW` as JSON
with `tenantId`, `accountId`, `feature`, `active`, `tokenSha256`, and
`expiresAt`. The caller sends the original token in the `x-feature-preview`
header. The preview changes only the response to the authorized read.
