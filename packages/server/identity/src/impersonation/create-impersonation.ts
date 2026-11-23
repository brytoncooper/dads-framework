import { randomUUID } from "node:crypto";
import type { IdentitySession } from "../identity-types.js";
import type { AuditContext } from "./audit.js";
import { createImpersonationAudit, ImpersonationAuditError } from "./audit.js";
import type {
  Impersonation,
  ImpersonationAction,
  ImpersonationGrant,
  ImpersonationOptions,
  ImpersonationScope,
  ImpersonationStoredGrant,
} from "./types.js";

function publicGrant(grant: ImpersonationStoredGrant): ImpersonationGrant {
  return {
    id: grant.id,
    staffAccountId: grant.staffAccountId,
    effectiveAccountId: grant.effectiveAccountId,
    tenantId: grant.tenantId,
    expiresAtMs: grant.expiresAtMs,
  };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && value.trim().length > 0 && !value.includes("\0");
}

export function createImpersonation(options: ImpersonationOptions): Impersonation {
  const { authorize, identity, lifetimeMs, store, writeAudit, now = Date.now } = options;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) {
    throw new RangeError("Impersonation lifetime must be a positive integer");
  }

  function attempt(
    action: ImpersonationAction,
    headers: Headers,
    initial: Partial<ImpersonationScope & { grantId: string }>,
  ) {
    const context: AuditContext = {
      action,
      actorAccountId: null,
      staffAccountId: null,
      effectiveAccountId: validId(initial.effectiveAccountId) ? initial.effectiveAccountId : null,
      tenantId: validId(initial.tenantId) ? initial.tenantId : null,
      grantId: validId(initial.grantId) ? initial.grantId : null,
    };
    const { audit, authorizedEvent } = createImpersonationAudit(writeAudit, now, context);
    const session = async () => {
      const session = await identity.readSession(headers);
      context.actorAccountId = session?.account.id ?? null;
      return session && session.expiresAt.getTime() > now() ? session : null;
    };
    const recordGrant = (grant: ImpersonationGrant) => {
      context.staffAccountId = grant.staffAccountId;
      context.effectiveAccountId = grant.effectiveAccountId;
      context.tenantId = grant.tenantId;
      context.grantId = grant.id;
    };
    const readGrant = async (id: string) => {
      const grant = validId(id) ? await store.read(id) : null;
      if (grant?.id !== id) return null;
      recordGrant(grant);
      return grant;
    };
    const run = async <Result>(work: () => Promise<Result>) => {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof ImpersonationAuditError)) await audit("error");
        throw error;
      }
    };
    return { session, recordGrant, readGrant, run, audit, authorizedEvent };
  }

  async function start(headers: Headers, scope: ImpersonationScope) {
    const request = attempt("start", headers, scope);
    return request.run(async () => {
      const session = await request.session();
      const { tenantId, effectiveAccountId } = scope;
      if (!session || !validId(session.sessionId) || !validId(tenantId) || !validId(effectiveAccountId)) {
        await request.audit("denied");
        return null;
      }
      const staffAccountId = session.account.id;
      const grant = {
        id: randomUUID(),
        tenantId,
        effectiveAccountId,
        staffAccountId,
        staffSessionId: session.sessionId,
        expiresAtMs: Math.min(now() + lifetimeMs, session.expiresAt.getTime()),
      };
      request.recordGrant(grant);
      if (staffAccountId === effectiveAccountId || !(await permitted("start", staffAccountId, grant))) {
        await request.audit("denied");
        return null;
      }
      if (grant.expiresAtMs > now()) {
        await store.insert(grant, request.authorizedEvent());
        if (grant.expiresAtMs > now()) return publicGrant(grant);
      }
      await request.audit("denied");
      return null;
    });
  }

  async function use(headers: Headers, input: { readonly grantId: string; readonly tenantId: string }) {
    const request = attempt("use", headers, input);
    return request.run(async () => {
      const session = await request.session();
      const grant = await request.readGrant(input.grantId);
      if (session && grant && matchesUse(session, input.tenantId, grant)) {
        if (await permitted("use", session.account.id, grant)) {
          await request.audit("authorized");
          if (await stillActive(grant, session.expiresAt.getTime())) return publicGrant(grant);
        }
      }
      await request.audit("denied");
      return null;
    });
  }

  function matchesUse(session: IdentitySession, tenantId: string, grant: ImpersonationStoredGrant) {
    return ownsGrant(session, grant) && grant.tenantId === tenantId && grant.expiresAtMs > now();
  }

  function ownsGrant(session: IdentitySession, grant: ImpersonationStoredGrant) {
    return session.account.id === grant.staffAccountId && session.sessionId === grant.staffSessionId;
  }

  async function stillActive(grant: ImpersonationStoredGrant, sessionExpiresAtMs: number) {
    const current = await store.read(grant.id);
    return (
      current?.id === grant.id &&
      current.staffAccountId === grant.staffAccountId &&
      current.staffSessionId === grant.staffSessionId &&
      current.effectiveAccountId === grant.effectiveAccountId &&
      current.tenantId === grant.tenantId &&
      current.expiresAtMs === grant.expiresAtMs &&
      Math.min(grant.expiresAtMs, sessionExpiresAtMs) > now()
    );
  }

  function permitted(action: "start" | "use" | "revoke", actorAccountId: string, grant: ImpersonationGrant) {
    return authorize({
      action,
      actorAccountId,
      staffAccountId: grant.staffAccountId,
      effectiveAccountId: grant.effectiveAccountId,
      tenantId: grant.tenantId,
    });
  }

  async function end(action: "stop" | "revoke", headers: Headers, grantId: string) {
    const request = attempt(action, headers, { grantId });
    return request.run(async () => {
      const session = await request.session();
      const grant = await request.readGrant(grantId);
      if (session && grant && (await mayEnd(action, session, grant))) {
        if (await store.remove(grant.id, request.authorizedEvent())) return true;
      }
      await request.audit("denied");
      return false;
    });
  }

  function mayEnd(action: "stop" | "revoke", session: IdentitySession, grant: ImpersonationStoredGrant) {
    return action === "stop" ? ownsGrant(session, grant) : permitted(action, session.account.id, grant);
  }

  return {
    start,
    use,
    stop: (headers, grantId) => end("stop", headers, grantId),
    revoke: (headers, grantId) => end("revoke", headers, grantId),
  };
}
