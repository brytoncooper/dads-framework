# Sign-in and tenant boundaries

A session identifies an account. Workspace membership determines what that
account can access. The starter uses Better Auth for the session and Postgres
relationships for workspace access.
[Identity contract](../../../packages/server/identity/README.md) ·
[Better Auth adapter](../../../packages/server/identity-better-auth/README.md)

## Try the invitation flow

Start the kit and create an account. Open the verification link from
`npm run dev:mail`, sign in, and create a workspace. Invite a collaborator
from the workspace panel, then use a separate browser profile to sign in as
the invitee. The recipient must verify the email address on the invitation
before accepting it.
[Starter walkthrough](../../../apps/kit-workbench/README.md)

Before accepting, try opening the workspace's notes using the invitee's
session. The API returns 404. After acceptance the recipient can read the
invited workspace. Reusing the same invitation does not create another
membership. The signed-session integration test also covers a wrong
recipient, expiration, and an unsigned request.
[Starter integration proof](../../../apps/kit-workbench/tests/starter.integration.test.ts)

## Wire tenant-aware requests

Mount the identity handler and resolve the account from the session at the
API boundary. Parse the tenant ID from the route and use the tenant
capability to check membership and roles. Scope database operations to
that verified tenant, and carry the same scope into flags and audit
where the operation uses them.
[Starter request wiring](../../../apps/kit-workbench/assembly/start-app.ts) ·
[Tenant capability](../../../packages/server/tenants/README.md)

Local mail and container tests exercise the flow on your machine. Before
deploying, exercise email delivery, verification and invitation links,
session cookies over HTTPS, and a guarded action with two accounts in the
target environment.
[Starter deployment guide](../../../apps/kit-workbench/DEPLOY.md)
