# Permissions are relationships

To explain why a person can read a workspace's notes, name what connects
them to that workspace. The starter checks the tenant view permission using
the tenant ID from the request. A signed-in outsider who knows that ID still
gets a 404. Start the kit, create two workspaces under different accounts,
and try reading one account's notes with the other's session.
[Starter commands](../../../apps/kit-workbench/README.md#call-the-customer-api-from-the-command-line)

## Follow the check to storage

The notes access declaration uses an exported tenant permission handle.
The list query uses the authorized tenant in its database filter. Keep
those two inputs aligned, then test which rows the caller actually receives.
For create and update routes, select the intended permission and keep the
write's permission recheck and related relationship changes within the
transaction where the provider supports it.
[Notes access](../../../apps/kit-workbench/domains/notes/access/index.ts) ·
[Notes routes](../../../apps/kit-workbench/domains/notes/server/routes.ts) ·
[Access model](../../../packages/access/README.md)

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/access/index.ts", "language": "ts", "from": "export const notesPermission = tenantAccess.tenant.permissions.view;", "through": "};"} -->

## Choose a provider

Choose the runtime implementation when you compose the application.

- **SpiceDB** evaluates the emitted model in its own relationship store.
  Use the framework's runtime fake for focused HTTP tests and run integration
  tests against SpiceDB for policies that rely on provider behavior.
  [SpiceDB authorization kit](../../../packages/server/authorization/README.md)
- **Postgres access** has **Trusted experimental** status. Use it when your
  business rows and relationship facts share a primary database and your
  policy fits the supported expressions. Using the same transaction lets a
  grant or revocation commit with the business write. Measure point checks
  and lists against your own graph before rollout.
  [Postgres access](../../../packages/server/postgres-access/README.md#trusted-experimental)

Add a grant, check access, remove it, and verify that a new request loses
access. Repeat the exercise through the list route as well as the record
route. [Tenant integration proof](../../../packages/server/tenants/src/tenants.integration.test.ts)
