# Sign-in and tenant boundaries

Use two accounts to see what changes when someone joins a workspace. Better
Auth identifies the signed-in account. The tenant kit uses that account's
relationships to decide whether it can read notes or manage invitations.

## Invite a collaborator

1. Run `npm start` in a generated starter and open the browser URL it prints.
   Create an account for `owner@example.test`, open the verification link from
   `npm run dev:mail`, then sign in. Create a workspace called **Alpha** and add a
   note that says “Kickoff on Tuesday.”
2. Open a separate browser profile and repeat sign-up and verification for
   `collaborator@example.test`. In the owner's profile, open **Invite a
   collaborator** and enter that email.
3. Run `npm run dev:mail` again and open the invitation in the collaborator's
   profile. Select **Accept invitation**. Select **Alpha** and read the note.

## Follow the API requests

The tenant ID is the `data.id` returned by `POST /api/tenants`. The owner
issues the invitation with their session cookie. Here and below, substitute
the actual workspace ID, browser origin, and credentials.

```http
POST /api/tenants/<alpha-id>/invitations
Cookie: <owner-session-cookie>
Origin: <browser-origin>
Content-Type: application/json

{"email":"collaborator@example.test"}
```

The API returns `201 Created` with `data.expiresAt`. The invitation email
delivers the token in the link's URL fragment.

```http
POST /api/tenants/invitations/accept
Cookie: <collaborator-session-cookie>
Origin: <browser-origin>
Content-Type: application/json

{"token":"<token-from-invitation-link>"}
```

The correct verified recipient gets `200 OK` with
`{"data":{"tenantId":"<alpha-id>"}}`. Try the same notes request before
and after acceptance.

```http
GET /api/tenants/<alpha-id>/notes
Cookie: <collaborator-session-cookie>
```

| Caller and state               | Result                                    |
| ------------------------------ | ----------------------------------------- |
| Collaborator before acceptance | `404`                                     |
| Collaborator after acceptance  | `200` with “Kickoff on Tuesday” in `data` |
| Caller without a session       | `401`                                     |

Accepting with the owner's cookie or replaying a used invitation returns
`404`. The browser origin must match the configured origin for acceptance.

## Set up the same services in an existing app

The generated starter applies its migrations when you run `npm start`. If you
own the migration history for a **fresh database**, install the default
identity and tenant schemas in an app migration. This example also installs
the PostgreSQL relationship tables used by the tenant directory.

The [example app migration](../../../fixtures/default-services/migrations/20261120000000_default_services.migration.ts)
lives under `migrations/` in the adopting project.

<!-- dads:excerpt {"path":"fixtures/default-services/migrations/20261120000000_default_services.migration.ts","language":"ts","from":"import { installIdentitySchemaV2 } from \"@dads-framework/identity-better-auth\";","through":"export const down = false;"} -->

The identity installer creates the signing-key columns Better Auth reads during
sign-in. The tenant installer creates the directory tables invitation acceptance
uses to detect deactivated accounts. You can use ordinary email invitations
with SCIM provisioning turned off.

For a database that already has V1 tables, apply the additive migrations
described in the [identity adapter](../../../packages/server/identity-better-auth/README.md)
and [tenant package](../../../packages/server/tenants/README.md). A starter
that has applied its enterprise identity migration already has these tables
and columns.

## Reuse the boundary on another route

Read the account from the session, use the route tenant ID in the
permission check, and use that same tenant ID in the database query. The
notes list uses one tenant predicate for both the rows and their count.

<!-- dads:excerpt {"path":"apps/kit-workbench/domains/notes/server/routes.ts","language":"ts","from":"      handler: async ({ params, query }) => {","through":"          db.select({ total: count() }).from(noteTable).where(scope),"} -->

The starter integration test exercises wrong-recipient, expired, replayed,
and unsigned invitations alongside successful redemption. [Signed-session test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
