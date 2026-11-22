# ADR-0005: Use Tenant in Framework Packages and Product Nouns in Application UIs

## Status

Accepted

## Date

2026-11-20

## Context

Multi-tenant applications name their shared customer container according to their product domain: collaboration apps call it a workspace, B2B administrative tools call it an organization or company, and vertical products call it a clinic, team, or school.

Framework infrastructure in `@dads-framework/tenants` owns reusable multi-tenant primitives across every adopting application: tenant records, membership rosters, one-time invitations, SCIM v2 user and group directories, feature-flag audiences (`context.audience`), and audit scopes (`tenantAuditConfiguration` over `tenant_id`). Naming the framework package after one product noun creates terminology collisions for every product with a different domain hierarchy, while exposing the infrastructure word "tenant" in end-user buttons and headings produces stiff product copy.

## Decision

Keep **`tenant`** as the uniform term in framework packages, schemas, and default tenant routes, and map it to the product's own noun at the application UI and copy layer.

1. **Framework and API layer:** `@dads-framework/tenants` exports `Tenants`, `createTenantAccess`, `tenantIdSchema`, `tenantAuditConfiguration`, and `installTenantSchemaV2`. Starter routes and persistence use `tenantId` (`GET /api/tenants/:tenantId/notes`, `noteTable.tenantId`).
2. **Product UI and copy layer:** Applications define user-facing nouns through `@dads-framework/copy`. In the starter (`apps/kit-workbench`), [`workbench-copy.ts`](../../apps/kit-workbench/apps/web/copy/workbench-copy.ts) maps keys such as `workbench.tenant.title` and `workbench.tenant.active` to "Workspaces" and "Active workspace", which [`WorkspacePicker`](../../apps/kit-workbench/apps/web/workspace-controls.tsx) renders over `readonly Tenant[]`.
3. **Explicit cross-reference:** The [Getting Started guide](../site/guides/index.md) documents the project layout and how `domains/tenants/` maps browser workspaces to `tenantId` parameters across HTTP routes and SQL `where` clauses.
4. **Domain autonomy outside the tenants kit:** Applications that define their own container domain instead of mounting `@dads-framework/tenants` (such as the Reference Workbench in `apps/workbench`) name their own contracts and routes in product language, following Principle 1 in [Dads guiding principles](../principles.md).

## Alternatives considered

### Name the framework package `@dads-framework/workspaces` or `@dads-framework/organizations`

- **Pros:** Matches the visible UI copy of many B2B starters out of the box.
- **Cons:** Collides with products that model both organizations and workspaces, or products whose primary container is a clinic, store, or team.
- **Rejected:** `tenant` names the security and isolation boundary without colliding with product vocabulary.

### Display "Tenant" in end-user UI copy

- **Pros:** Removes the terminology translation between backend code and browser screens.
- **Cons:** Exposes internal multi-tenancy jargon to customers who expect product terms like "Workspace" or "Organization".
- **Rejected:** End-user interfaces should speak the product's language rather than infrastructure terms.

### Parameterize SQL table names and HTTP route prefixes inside `@dads-framework/tenants`

- **Pros:** Lets each application generate `/api/clinics/:clinicId` and `clinic_memberships` tables from framework configuration.
- **Cons:** Complicates schema migrations (`installTenantSchemaV2`), SCIM bindings, audit column names (`tenant_id`), and troubleshooting across projects for little gain when UI copy handles user-facing labels.
- **Rejected:** Static schema and route identifiers keep migrations, audit schemas, and documentation predictable.

## Consequences

- Framework packages, SQL migrations, SCIM directories, audit scopes, and feature-flag audiences share one consistent isolation identifier (`tenant`) across all Dads applications.
- Teams customize every end-user label in one `@dads-framework/copy` dictionary (for example replacing "Workspace" with "Organization" or "Clinic") without touching database migrations or `@dads-framework/tenants`.
- Contributors debugging the starter must connect UI "Workspace" actions to `tenantId` in `/api/tenants/:tenantId/*` routes and `noteTable.tenantId`. Explicit component prop types (`tenants: readonly Tenant[]`) and the [Getting Started guide](../site/guides/index.md) make that mapping discoverable.

## References

- [Getting Started guide](../site/guides/index.md)
- [`@dads-framework/tenants` README](../../packages/server/tenants/README.md)
- [Tenant permission rules](../../packages/server/tenants/src/tenant-access.ts)
- [Starter workspace controls](../../apps/kit-workbench/apps/web/workspace-controls.tsx)
- [Starter UI copy dictionary](../../apps/kit-workbench/apps/web/copy/workbench-copy.ts)
- [Starter Notes routes](../../apps/kit-workbench/domains/notes/server/routes.ts)
- [Dads guiding principles](../principles.md)
