# Preview Notes export availability for one account

Complete the [example setup](./README.md) first. The starter migration enables
`notes.export` for everyone. Configure a ten-minute preview that turns it off
for the owner of this tenant. The customer API checks the configured account's
current tenant view permission and stores only the token's SHA-256 digest in
its preview configuration.

```sh
preview_token=$(openssl rand -hex 32)
digest=$(printf '%s' "$preview_token" | openssl dgst -sha256 -r | cut -d ' ' -f 1)
expiry=$(node -p 'new Date(Date.now() + 10 * 60 * 1000).toISOString()')
export DADS_FEATURE_PREVIEW=$(
  jq -cn --arg owner "$ownerId" --arg tenant "$tenant" \
    --arg digest "$digest" --arg expiry "$expiry" \
    '{accountId: $owner, tenantId: $tenant, feature: "notes.export",
      active: false, tokenSha256: $digest, expiresAt: $expiry}'
)
npm --prefix ../.. run dev:up
. ./env.sh
```

Read feature state with and without the token. Both requests return HTTP 200 with
`data.features` and `data.stateHash`.

```sh
features_url="$web/api/tenants/$tenant/notes/features"

curl -fsS -b owner.cookies "$features_url" | jq '.data.features'
curl -fsS -b owner.cookies -H "x-feature-preview: $preview_token" \
  "$features_url" | jq '.data.features'
```

Expect `["notes.export"]` for the ordinary request and `[]` for the preview.
Send the same token as the other tenant member to check that the account binding
holds. The response includes `x-feature-preview-dropped: 1` and the ordinary
feature state with `notes.export`.

```sh
curl -fsS -i -b member.cookies -H "x-feature-preview: $preview_token" \
  "$features_url"

curl -fsS -b owner.cookies "$features_url" | jq '.data.features'
```

The final request still returns `["notes.export"]`. Previewing is read-only and
the rollout stays enabled.

To remove the preview before it expires, unset the configuration and reapply it.

```sh
unset DADS_FEATURE_PREVIEW preview_token
npm --prefix ../.. run dev:up
. ./env.sh
```
