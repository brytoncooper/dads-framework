# Export one workspace's audit metadata

Use the sessions and running APIs from [example setup](./README.md). Write
notes on the customer API and download audit pages from the staff API. The
caller must own the workspace. The staff API checks the workspace's
`manage_tenant` permission on each page.

## Write two changes you can find in the export

```sh
sample="audit-example-$(date +%s)-$$"
notes="$customer/api/tenants/$tenant/notes"
for change in first second; do
  curl -fsS -b owner.cookies "$notes" \
    -H "X-Request-Id: $sample-$change" \
    --json "{\"text\":\"Audit example $change\"}" >/dev/null
done
```

Each insert records a tenant-scoped audit entry. The request IDs let you
match the entries to the two writes.

## Download two pages

```sh
export_url="$staff/api/tenants/$tenant/audit-log/export"
audit_dir=$(mktemp -d)
curl -fsS -b owner.cookies "$export_url?pageSize=1" \
  -D "$audit_dir/headers" -o "$audit_dir/page-1.ndjson"

next=$(sed -nE 's/^[Ll]ink: <([^>]+)>; rel="next".*/\1/p' "$audit_dir/headers")
curl -fsS -b owner.cookies "$staff$next" -o "$audit_dir/page-2.ndjson"

jq -c '{tableName, operation, requestId}' "$audit_dir"/page-*.ndjson
```

Both pages return **200** with `Content-Type: application/x-ndjson`. Each
line is a JSON object. The projection above prints the most recent write
first. The request ID suffix is unique to your run.

```text
{"tableName":"starter_note","operation":"insert","requestId":"audit-example-1795183200-12345-second"}
{"tableName":"starter_note","operation":"insert","requestId":"audit-example-1795183200-12345-first"}
```

The full lines include `position`, `recordedAt`, `actorKind`, `actorId`,
`userId`, and `changedColumns`. They contain metadata about the write.
Stored note text and row snapshots are excluded. Follow the relative
`Link` target with `rel="next"` to continue. The link is absent on the final page.

## Check the workspace boundary

```sh
curl -sS -i -w '\n' -b member.cookies "$staff$next"
curl -sS -i -w '\n' -b outsider.cookies "$export_url"
curl -sS -i -w '\n' -b owner.cookies "$customer/api/tenants/$tenant/audit-log/export"
```

Each request returns **404**. A regular member cannot export a workspace,
an outsider has no grant, and the customer API does not mount the route.
See [audit-export.ts](../domains/tenants/server/audit-export.ts) for the
permission guard and export setup.
