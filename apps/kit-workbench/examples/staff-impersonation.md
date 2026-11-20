# View a tenant as a member from the staff API

## How the starter implements it

[assembly/staff-impersonation-services.ts](../assembly/staff-impersonation-services.ts)
creates a Postgres-backed grant service and applies the configured tenant's
SSO policy to the staff session. Its authorization callback checks the
operator allowlist and the target account's current ability to view the
workspace. [domains/support/server/impersonation.ts](../domains/support/server/impersonation.ts)
handles the commands; [assembly/start-app.ts](../assembly/start-app.ts)
mounts them on the staff API when enabled.

<!-- dads:excerpt {"path":"assembly/staff-impersonation-services.ts","language":"ts","from":"  const staff = new Set(staffAccountIds);","through":"    );"} -->

## Try it

Complete the [example setup](./README.md) first. For this exercise the owner
represents an approved support operator and the member is the target.

```sh
export DADS_ENTERPRISE_STAFF_IMPERSONATION=$(
  jq -cn --arg tenant "$tenant" --arg owner "$ownerId" \
    '{tenantId: $tenant, staffAccountIds: [$owner], revokerAccountIds: []}'
)
npm --prefix ../.. run dev:up
. ./env.sh
```

The staff endpoint requires the operator's session cookie and the exact
configured origin. In local Compose, both APIs use the web URL as
`DADS_BASE_URL`, so send `Origin: $web` to the staff API at `$staff`.

```sh
staff_command() {
  curl -sS -b owner.cookies -H "Origin: $web" \
    -H 'Content-Type: application/json' --data "$1" \
    "$staff/api/staff/impersonation"
}

issued=$(staff_command "$(jq -cn --arg member "$memberId" \
  '{action: "start", effectiveAccountId: $member}')")
printf '%s\n' "$issued" | jq .
grant=$(printf '%s\n' "$issued" | jq -er '.id')

view=$(jq -cn --arg grant "$grant" '{action: "view-tenant", grantId: $grant}')
staff_command "$view" | jq .
```

The start request returns HTTP 201 with `id`, `staffAccountId`,
`effectiveAccountId`, `tenantId`, and `expiresAtMs`. The view returns HTTP 200
with the owner's ID in `staffAccountId`, the member's ID in
`effectiveAccountId`, and the tenant's `id` and `name` under `tenant`.
The grant is bound to the issuing session and expires within five minutes.

```sh
staff_command "$(jq -cn --arg grant "$grant" \
  '{action: "stop", grantId: $grant}')" | jq .

curl -sS -o /dev/null -w '%{http_code}\n' -b owner.cookies \
  -H "Origin: $web" -H 'Content-Type: application/json' \
  --data "$view" "$staff/api/staff/impersonation"
```

Expect `{"stopped":true}` then HTTP 404 when you try the stopped grant again.

To unmount the endpoint, unset the setting and reapply the Compose configuration.

```sh
unset DADS_ENTERPRISE_STAFF_IMPERSONATION
npm --prefix ../.. run dev:up
. ./env.sh
```
