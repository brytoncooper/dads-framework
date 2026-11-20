# Permissions are relationships

Model a subject, a resource, and the relationship that gives access. A route
passes the subject and parsed resource ID to the authorization capability.
The application chooses the provider when assembling the API.

- [Access model](../../../packages/access/README.md) defines kinds, roles,
  permissions, and the policy emitted from them.
- [SpiceDB authorization](../../../packages/server/authorization/README.md) implements the
  runtime interface. Use its test fake for a focused HTTP proof.
- [Postgres access](../../../packages/server/postgres-access/README.md#trusted-experimental)
  has **Trusted experimental** status. We recommend it when your records and
  permission relationships share one Postgres database and your policy fits
  the adapter. A grant or revocation commits with the business change, so
  there is no authorization outbox to deliver or monitor.

Prove access with a real relationship and refusal without it. The
[note fixture](./guarded-resource.md) runs both requests through the route.
For a list, test that an unrelated subject cannot read another scope's rows.
