# Try the starter examples

Each example links to the starter's implementation and gives you a way to
try it. Run the API tests from the root of your generated project. Tests
that require Docker start their own temporary database.

## Prepare browser accounts

The permissions dashboard and local SSO walkthrough use a running
workbench. With Docker running, execute these commands from the project root:

```sh
npm start
npm run examples:setup
```

The setup verifies an owner, a member, and an outsider through the local
mailbox. It creates a workspace and accepts the member's invitation.
Find the sign-in details in `.dads/examples/accounts.json`. Keep this
file and the saved sessions private.

For the local SSO walkthrough, load the workspace ID and local URLs:

```sh
cd .dads/examples
. ./env.sh
```

## Explore an implementation

| Exercise                                            | What you can observe                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Permissions dashboard](./permissions-dashboard.md) | See what an owner, member, and outsider can access.                                                                                                   |
| [Audit export](./audit-export.md)                   | Read a workspace’s audited writes in two pages and check who can export them.                                                                         |
| [Feature preview](./flag-preview.md)                | Enable a Notes export preview for an account after it gains workspace membership.                                                                     |
| [Staff impersonation](./staff-impersonation.md)     | Issue a grant, view the workspace as the member, stop the grant, and see the next request denied.                                                     |
| [Directory sync with SCIM](./directory-sync.md)     | Provision a directory user and group, then deactivate the user with a tenant-bound bearer credential.                                                 |
| [Company sign-in with SSO](./company-sso.md)        | Verify your domain, complete an IdP sign-in in the browser, then exercise required SSO. You’ll need DNS access and an identity provider for this one. |
