# Provision users and groups with SCIM

## How the starter implements it

[assembly/start-app.ts](../assembly/start-app.ts) mounts the SCIM handler at
`/scim/v2` on the configured customer API. [assembly/scim.ts](../assembly/scim.ts)
connects the user and group adapters to the tenant database. The bearer
credential determines which tenant the directory can manage.

<!-- dads:excerpt {"path":"assembly/scim.ts","language":"ts","from":"  return createScimHandler({","through":"    },"} -->

A directory record becomes linked to an existing app membership only when the
owner invokes [domains/tenants/server/scim-binding-route.ts](../domains/tenants/server/scim-binding-route.ts).
The route checks that SCIM is enabled for that workspace, then calls the
tenant service to make the link in a transaction.

<!-- dads:excerpt {"path":"domains/tenants/server/scim-binding-route.ts","language":"ts","from":"        const { tenantId, scimUserId } = params.data;","through":"        }"} -->

## Try it

Run the SCIM integration test from the generated project with Docker running:

```sh
npm test -- tests/enterprise-scim.integration.test.ts
```

[The test](../tests/enterprise-scim.integration.test.ts) uses a temporary
database with two tenants and a bearer credential for each. The first
tenant's credential creates a user and a group with HTTP 201. A request
without a token gets HTTP 401, and the second tenant's credential gets
HTTP 404 when it tries to read the first tenant's user. The authorized
credential can deactivate the user and receives HTTP 200 with
`active: false`.

An owner can link a directory user to an existing workspace member.
After a linked user is deactivated or deleted, the tenant adapter revokes
that membership. See [SCIM user provisioning](../DEPLOY.md#scim-user-provisioning)
for the binding request and identity provider configuration.
