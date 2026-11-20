# Staff impersonation

Use `createImpersonation` from `@dads-framework/identity/impersonation` to authorize short-lived staff access as a specific account in a specific tenant. The original staff session supplies the actor identity on every call.

```ts
import { createImpersonation } from "@dads-framework/identity/impersonation";

// Application adapters implement identity, storage, tenant policy, and audit.
const impersonation = createImpersonation({
  identity,
  store: impersonationStore,
  authorize: checkTenantImpersonationPermission,
  writeAudit: appendImpersonationAudit,
  lifetimeMs: 5 * 60_000,
});

const grant = await impersonation.start(request.headers, {
  tenantId: routeTenantId,
  effectiveAccountId: selectedAccountId,
});

// On each subsequent request, take tenantId from the route's tenant context.
const admitted = await impersonation.use(request.headers, {
  grantId: suppliedGrantId,
  tenantId: routeTenantId,
});
```

Handle a null admission as a denial on an impersonated route. Use the declared tenant and effective account for ordinary resource authorization, and retain the staff account and grant ID in application operation logs. Attach admission to a single request and use it only inside the checked tenant. Keep identity-management and impersonation-control routes under real-actor authorization. The API returns a scope that applications apply to their own authorization and operation auditing.

The tenant policy supplies explicit staff permission and verifies target membership for both `start` and `use`. The `revoke` action checks the requesting administrator's revocation permission in the grant's tenant. `stop` is available to the original authenticated staff session, including after staff permission or grant expiry. Both commands remove the grant. Return an application error on operational failures.

The store must insert immutable grants under unique IDs, commit successful mutations and their audit records atomically, and provide strongly consistent reads across application instances. Configure a short lifetime. Use an authoritative clock across instances and periodically delete expired grants. A grant expires at the earlier of the configured lifetime and the original session's expiry. Each use requires the same valid staff session and current tenant permission. Configure an identity adapter whose server-side session lookup returns a stable, non-credential `sessionId`. The API keeps that identifier in the grant store and omits it from admission scopes and audit events. For Better Auth, spread the result of `createPostgresImpersonationStore(pool)` from `@dads-framework/identity-better-auth/impersonation-store` into the options to supply both storage and audit.

Start atomically commits its audit record with the grant. Use requires the audit writer to acknowledge a durable record before returning admission. Records carry the authenticated caller, original staff account and effective account where known. They describe gate decisions and backend errors. A concurrent revocation or expiration can produce an authorized audit record followed by a denied record. On audit failure, `ImpersonationAuditError` retains the event and original cause for application alerting. A failed atomic audit write rolls back the corresponding grant creation or removal. A failed removal must be retried.
