# Provision users and groups with SCIM

Create a directory user in one workspace, add the user to a group, then
deactivate the user. Run the commands in Bash with curl, jq, and OpenSSL.

## Configure the customer API

Run [example setup](./README.md) and keep your Bash terminal in
`.dads/examples`. Load the workspace ID and API URLs from the setup.
Put the bearer token's digest in the customer API configuration, then
refresh the URLs after applying it.

```sh
. ./env.sh
scim_token=$(openssl rand -hex 32)
digest=$(printf '%s' "$scim_token" | openssl dgst -sha256 -r | cut -d' ' -f1)
export DADS_ENTERPRISE_SCIM=$(jq -cn --arg tenant "$tenant" --arg digest "$digest" \
  '[{tenantId:$tenant,tokenSha256:$digest}]')

npm --prefix ../.. run dev:up
. ./env.sh
```

Keep the token in this shell for the requests. For an IdP pilot, store the
token at the IdP and point it at `https://<customer-api-origin>/scim/v2`.

## Create a user and a group

```sh
base="$customer"
auth=(-H "Authorization: Bearer $scim_token")
scim_json=(-H 'Content-Type: application/scim+json')

member_email=$(curl -fsS -b member.cookies "$web/api/auth/get-session" | jq -er '.account.email')
profile=$(jq -cn --arg email "$member_email" \
  '{schemas:["urn:ietf:params:scim:schemas:core:2.0:User"],userName:$email}')
user=$(curl -fsS "${auth[@]}" "${scim_json[@]}" "$base/scim/v2/Users" \
  --data "$profile")
user_id=$(jq -er '.id' <<< "$user")
jq '{id,userName,active}' <<< "$user"

curl -fsS "${auth[@]}" "$base/scim/v2/Users" | jq --arg id "$user_id" \
  '.Resources[] | select(.id == $id) | {id,userName,active}'
```

Creation returns `201` and the user is active. Listing returns `200`; the
example selects the saved user from the first page. Use a fresh directory
so that user appears on the first page.

```sh
group=$(jq -cn --arg id "$user_id" \
  '{schemas:["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName:"Engineering",members:[{value:$id}]}')
created_group=$(curl -fsS "${auth[@]}" "${scim_json[@]}" "$base/scim/v2/Groups" \
  --data "$group")
group_id=$(jq -er '.id' <<< "$created_group")
jq '{id,displayName,members}' <<< "$created_group"
```

The group request returns `201` with the user ID in `members[].value`.
SCIM users and groups are directory records. Workbench permissions come
from the application's workspace memberships.

## Link a membership and test offboarding

Confirm the member can read workspace notes, then link the directory ID
to the existing app membership using the tenant owner's session.

```sh
notes="$customer/api/tenants/$tenant/notes"
curl -sS -i -b member.cookies "$notes"

jq -cn --arg accountId "$memberId" '{accountId:$accountId}' |
  curl -fsS -i -b owner.cookies -H "Origin: $web" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$customer/api/tenants/$tenant/scim/users/$user_id/bind"
```

Expect `200` for the notes request and `204` for the binding.
The customer API enables the owner action only for workspaces configured
for SCIM. It uses the owner's existing `manage_tenant` permission and
requires an existing app membership. A matching email address alone
leaves the directory record unlinked.

```sh
curl -fsS "${auth[@]}" "${scim_json[@]}" -X PATCH "$base/scim/v2/Users/$user_id" \
  --data '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}' |
  jq '{id,active}'
```

Expect `200` and `active: false`. Repeat the notes request with the same
session.

```sh
curl -sS -i -b member.cookies "$notes"
```

Expect `404`. The linked membership in this workspace is revoked.
Memberships in other workspaces continue to work. A request without the SCIM token returns
`401` on the configured customer API. A valid token for a different
workspace gets `404` when reading this user by ID.
