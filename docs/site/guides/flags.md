# Feature flags

In the starter, enabling `notes.export` lets workspace members download
a note as CSV or PDF. The flag definition defaults to off. A starter
migration enables it globally so exports work on a fresh install.

## Read and use the flag

Start the app, sign in, create an **Alpha** workspace, and add a note. The
workbench reads the active workspace's feature state and shows the download
buttons when the returned feature list includes `notes.export`.

```http
GET /api/tenants/<alpha-id>/notes/features
Cookie: <alpha-member-session-cookie>
```

In the fresh starter, the `200 OK` response includes the following data.

```json
{ "data": { "features": ["notes.export"], "stateHash": "<opaque-state-hash>" } }
```

Download CSV from the note list or request the export directly using the
note ID returned by the notes API.

```http
GET /api/tenants/<alpha-id>/notes/<note-id>/exports/csv
Cookie: <alpha-member-session-cookie>
```

The export returns `200` with `data.contentType` set to `text/csv`
and `data.base64` containing the encoded file. The route checks workspace
permission, evaluates the flag for the route's tenant, and looks up the
note within that same tenant. A Beta-only member requesting Alpha's
features or export gets `404`, even while the flag is on globally.

## Preview the rollout with the default off

On a disposable starter database, use a rollout with the flag off.
For a fresh starter project, you can omit the sample
`20261120080200_enable_notes_exports.migration.ts` **before** applying
any migrations. An Alpha member then sees an empty `data.features` array
and gets `404` on the export route.

Generate a preview token and obtain its digest.

```sh
preview_token=$(openssl rand -hex 32)
printf '%s' "$preview_token" | openssl dgst -sha256
```

Set `DADS_FEATURE_PREVIEW` on the customer API and restart it. Substitute
the Alpha member's account ID, workspace ID, and digest, and choose a
future expiry.

```json
{
  "accountId": "<alpha-member-account-id>",
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "feature": "notes.export",
  "active": true,
  "tokenSha256": "<sha256-hex-digest>",
  "expiresAt": "2030-01-01T12:00:00Z"
}
```

Send the same feature and export requests with
`x-feature-preview: <preview-token>` and the Alpha member's session
cookie. The feature list now includes `notes.export` and the export
succeeds. Remove the header and the saved off state applies again.
Use the preview against Beta with a Beta member session to confirm it
doesn't enable export there.

## Define your own flag

Give a flag an owner, a default, and a removal condition. The notes domain
contributes this definition through its plugin.

<!-- dads:excerpt {"path":"apps/kit-workbench/domains/notes/server/flags.ts","language":"ts","from":"export const notesExportFlag = defineFeatureFlag({","through":"});"} -->

Use revision-checked updates for saved rollout changes. Test the default
off state, an enabled tenant, and a caller without membership.

[Preview-test coverage](../../../apps/kit-workbench/tests/feature-previews.test.ts) ·
[Export-test coverage](../../../apps/kit-workbench/tests/note-artifacts.test-support.ts) ·
[Flag lifecycle](../../../packages/server/feature-flags/README.md)
