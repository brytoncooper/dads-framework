# ADR-0002: Fail Closed with HTTP 404 on Authorization Denial Before Validation and Rate Limiting

## Status

Accepted

## Date

2026-11-20

## Context

Multi-tenant APIs serve resource-scoped URLs such as `GET /api/tenants/:tenantId/notes` and `POST /api/tenants/:tenantId/notes`. If an endpoint returns `403 Forbidden` when a resource exists without permission and `404 Not Found` when the resource does not exist, any signed-in user can enumerate tenant or record identifiers.

Pipeline ordering creates a second oracle. Running Zod input validation (`400 VALIDATION_FAILED`) or per-caller rate limiting (`429`) before authorization lets an unauthorized caller probe validation rules, detect whether a route accepted a target ID, or drain rate-limit budgets on unauthorized requests.

## Decision

Run access enforcement first in the HTTP pipeline inside [`registerRoutes`](../../packages/server/http/src/lib/request-pipeline/register-routes.ts), before feature-state checks, per-route rate limiting (`consumeBudget`), and Zod input parsing (`runRoute`).

1. **Pure decision table:** [`enforceAccess`](../../packages/server/http/src/lib/request-pipeline/enforce-access.ts) resolves the caller through `SubjectResolver` and delegates the access verdict to [`evaluateRouteAccess`](../../packages/access/src/runtime/route-access.ts).
2. **401 for missing authentication:** When no valid session or credential resolves a subject (`outcome: "unauthenticated"`), `sendAccessRefusal` responds with HTTP `401` and `{ error: { code: "NOT_AUTHENTICATED", message: "Authentication required" } }`.
3. **404 for authorization denial:** When a resolved caller fails a permission check, misses a required resource ID, or fails authorization-context resolution (`outcome: "not-found"`), `sendAccessRefusal` responds with HTTP `404`, the body `{ error: { code: "RESOURCE_NOT_FOUND", message: "Resource not found" } }`, and the internal edge-refusal header (`ACCESS_REFUSAL_HEADER`). Missing records and denied resources return the same body shape.
4. **Server-side denial diagnostics:** `enforceAccess` invokes the `onDenied` hook with structured `AccessDenial` details (`subjectType`, `subjectId`, `permission`, `resourceType`, `resourceId`, `url`, `authMethod`) and records refusal context via `rememberAccessOutcome` and `rememberRefusedAuditActor` for request logs without exposing details on the wire.
5. **Fail-closed list visibility:** On `requiresVisible` routes, an empty `visibleIds` array short-circuits to an empty page without invoking the handler.
6. **Mechanical checks:** `dad doctor` flags direct `403` patterns (`forbidden-403`), denial payloads with diagnostic bodies (`denial-with-body`), and protected routes lacking denial proofs (`access-without-denial-test`).

## Alternatives considered

### Return HTTP 403 Forbidden on denied permission checks

- **Pros:** Follows textbook HTTP semantics for resources whose existence is public and lets clients distinguish missing permissions from deleted items.
- **Cons:** Leaks resource existence across tenant boundaries by default and puts the burden on every route author to override `403` with `404` on multi-tenant endpoints.
- **Rejected:** Multi-tenant resources must hide existence from unauthorized callers by default.

### Validate inputs with Zod before checking authorization

- **Pros:** Rejects malformed JSON payloads and invalid UUIDs before querying the authorization backend.
- **Cons:** Creates an existence and schema-probing side channel when invalid payloads return `400` on accessible routes and `404` elsewhere, and executes schema parsers against untrusted inputs from unauthorized callers.
- **Rejected:** Authorization must run on raw request inputs before input validation runs.

### Consume per-route rate-limit budgets before authorization

- **Pros:** Throttles repeated denied checks inside the route's in-process rate limiter.
- **Cons:** Returning `429` before access enforcement reveals route behavior to unauthorized callers and lets denied requests exhaust a caller's budget.
- **Rejected:** Per-route `rateLimit` capabilities run after `enforceAccess`; volumetric flood protection belongs at the network edge or ingress proxy.

## Consequences

- Signed-in callers outside a tenant receive identical `404 RESOURCE_NOT_FOUND` bodies for missing IDs and inaccessible IDs, closing ID-enumeration and schema-probing side channels.
- Handlers never run for unauthenticated or unauthorized requests, and rate-limit budgets apply to authorized traffic.
- Client code cannot distinguish a revoked membership from a deleted resource using the response body alone. Engineers use the server-side `onDenied` hook and request logs to diagnose unexpected `404` responses.
- Because `enforceAccess` reads raw `params`, `query`, `body`, or `headers` before Zod validation, a missing or invalid resource ID source returns fail-closed `404` rather than `400`.

## References

- [`enforceAccess`](../../packages/server/http/src/lib/request-pipeline/enforce-access.ts)
- [`registerRoutes`](../../packages/server/http/src/lib/request-pipeline/register-routes.ts)
- [`runRoute`](../../packages/server/http/src/lib/request-pipeline/run-route.ts)
- [`evaluateRouteAccess`](../../packages/access/src/runtime/route-access.ts)
- [Permissions guide](../site/guides/permissions.md)
- [Routes, contracts, and clients guide](../site/guides/routes-and-contracts.md)
- [`dad doctor` reference](../doctor.md)
