# Sign-in and tenant boundaries

Authentication establishes the caller. Authorization decides what that
caller can do in the active tenant or to a record.

1. Compose the [identity contract](../../../packages/server/identity/README.md)
   with the [Better Auth adapter](../../../packages/server/identity-better-auth/README.md).
   Apply its database migration, configure a confidential mail queue and
   session secret, and mount the handler at its documented path.
2. Read the verified account from the session. Parse the request's tenant ID
   and resolve the account and tenant through the
   [tenant capability](../../../packages/server/tenants/README.md). Use the
   returned context for authorization, flags, and audit scope.
3. Prove that an otherwise valid caller cannot reach a different tenant.
   The [tenant integration proof](../../../packages/server/tenants/src/tenants.integration.test.ts)
   exercises the relationship checks and invite redemption against Postgres.
   Follow the [guarded resource guide](./guarded-resource.md) to add an HTTP
   refusal test for each protected surface.

Use the generated project's README for local run commands. Before deploying,
verify HTTPS, session cookies, email delivery, tenant provisioning, and
permission refusal in the target environment. Hosted onboarding from sign-in
through a guarded action still needs end-to-end proof.
