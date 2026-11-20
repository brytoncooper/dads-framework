# Try the starter examples

Each example starts with the files and code that implement the feature in
your generated app. Open the starter-relative source links to see the full
implementation, then use the **Try it** section to exercise it. The same
workspace supplies an owner, an invited member, and an outsider so you can
verify where access changes.

## Prepare your workspace

Start Docker. From the root of your generated project, run:

```sh
npm start
npm run examples:setup
cd .dads/examples
. ./env.sh
```

The setup creates the accounts, verifies their email through the local mailbox, and accepts the member’s invitation. It writes `owner.cookies`, `member.cookies`, and `outsider.cookies` for curl. For browser exercises, read the local sign-in details in `accounts.json`. These files contain credentials and belong in the ignored `.dads/examples/` directory.

Run the shell examples from that directory with Bash, curl, jq, and OpenSSL available. The environment file sets `$web`, `$customer`, `$staff`, `$tenant`, `$ownerId`, and `$memberId`. Source it again after applying a configuration change to pick up the current ports.

## Explore an implementation

| Exercise                                            | What you can observe                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Permissions dashboard](./permissions-dashboard.md) | Inspect a member’s effective permissions as the owner, then repeat the request as an outsider.                                                        |
| [Audit export](./audit-export.md)                   | Write two notes and find both request IDs in the staff API’s paginated NDJSON export.                                                                 |
| [Feature preview](./flag-preview.md)                | Switch off the notes export flag for one account’s preview and compare the ordinary response.                                                         |
| [Staff impersonation](./staff-impersonation.md)     | Issue a grant, view the workspace as the member, stop the grant, and see the next request denied.                                                     |
| [Directory sync with SCIM](./directory-sync.md)     | Provision a directory user and group, then deactivate the user with a tenant-bound bearer credential.                                                 |
| [Company sign-in with SSO](./company-sso.md)        | Verify your domain, complete an IdP sign-in in the browser, then exercise required SSO. You’ll need DNS access and an identity provider for this one. |
