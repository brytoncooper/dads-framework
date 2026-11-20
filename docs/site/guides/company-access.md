# Connect a company directory

When a customer asks to use their company login, there are two decisions to make. Who can prove that a person works for the company? What can that person do in a workspace? In Dads, the identity provider handles sign-in. Your application's tenant memberships and permission model control access to records.

## Roll out company sign-in

Start with a workspace you administer. Configure its OIDC or SAML provider in optional mode, prove ownership of the email domain with the DNS challenge, and complete a sign-in as a test member. Open a protected workspace route with that account. Then try the same route as a verified account that has no membership. Once both results match your policy, switch the tenant to required mode and retest an existing password session. Apply the same policy to every API that serves the tenant. [Provider setup](../../../packages/server/identity-better-auth/README.md) · [Starter deployment](../../../apps/kit-workbench/DEPLOY.md)

## Provision and remove a member

Give the directory a provisioning token scoped to that workspace. The starter accepts SCIM requests at `/scim/v2`. Linking a directory user to an existing local membership is an explicit administrative action. A matching email address alone grants no access.

For an offboarding test, open a protected workspace resource as a linked member, deactivate the user in the directory, then repeat the request with the same session. The membership and its authorization relationships are removed together. Verify that memberships in the person's other workspaces still work. [SCIM resources](../../../packages/server/identity/README.md) · [Postgres directory and account linking](../../../packages/server/tenants/README.md)

## Investigate an access question

- **Can this member manage the workspace?** Open **Permissions** in the starter and select the member. The API checks their effective permissions against the workspace's current relationships. [Starter walkthrough](../../../apps/kit-workbench/README.md)
- **Who changed a record?** The audit exporter checks the requesting actor's tenant permission on each page and returns a bounded page of metadata as NDJSON. Row images stay out of the export. [Audit export](../../../packages/server/audit/README.md)
- **Can support reproduce what the customer sees?** Issue a short-lived impersonation grant for one staff session, one target account, and one workspace. Each use requires a live permission check and records both identities. [Audited impersonation](../../../packages/server/identity/src/impersonation/README.md)
- **What would a feature change look like?** Give one account a preview for the selected tenant. The starter's preview is read-only and expires without changing the saved rollout. [Preview configuration](../../../apps/kit-workbench/assembly/LOCAL-DEV.md)
