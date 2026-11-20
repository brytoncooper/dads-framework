# Inspect a workspace member's permissions

Use the sessions from [example setup](./README.md). The owner and the invited
member belong to the same workspace. The outsider has a verified account
and no relationship to that workspace.

## Look up the member and check their permissions

As the owner, request the roster and select the account with the `member`
role. The roster returns `data` entries with `accountId` and `role`, plus
pagination in `meta`.

```sh
roster="$customer/api/tenants/$tenant/members"
member_id=$(curl -fsS -b owner.cookies "$roster" |
  jq -er '[.data[] | select(.role == "member")] | first | .accountId')
permissions="$roster/$member_id/permissions"
curl -fsS -b owner.cookies "$permissions" | jq .
```

The fresh workspace returns this decision for the invited member.

```json
{
  "data": {
    "role": "member",
    "view": true,
    "manageMembers": false,
    "manageTenant": false
  }
}
```

Sign in as the owner at `$web`, select the example workspace, and open
**Permissions**. Choose the account ID printed by `printf '%s\n' "$member_id"`.
The dashboard shows **Member**, with **View workspace** allowed and
**Manage members** and **Manage workspace settings** denied.

## Try the same inspection with the other sessions

```sh
curl -sS -i -w '\n' -b member.cookies "$permissions"
curl -sS -i -w '\n' -b outsider.cookies "$permissions"
```

Both requests return **404** with `error.code` set to `RESOURCE_NOT_FOUND`.
Owners and admins have the workspace's `manage_members` permission, which
guards both roster and inspection routes. Ordinary members can view the
workspace and its notes. In [permission-routes.ts](../domains/tenants/server/permission-routes.ts)
the caller must pass the inspection guard before the route evaluates the
selected account's permissions.
