import { describe, expect, it, vi } from "vitest";
import type { IdentitySession } from "../identity-types.js";
import { ImpersonationAuditError, createImpersonation } from "./index.js";
import type { ImpersonationAuditEvent, ImpersonationStoredGrant } from "./index.js";

const scope = { tenantId: "tenant", effectiveAccountId: "customer" };
const staff = new Headers({ "x-test-account": "staff" });
const admin = new Headers({ "x-test-account": "admin" });

function setup() {
  let now = 1_000;
  const grants = new Map<string, ImpersonationStoredGrant>();
  const authorize = vi.fn(() => Promise.resolve(true));
  const writeAudit = vi.fn<(event: ImpersonationAuditEvent) => Promise<void>>(() => Promise.resolve());
  const readSession = vi.fn((headers: Headers): Promise<IdentitySession | null> => {
    const id = headers.get("x-test-account");
    return Promise.resolve(
      id
        ? {
            account: {
              id,
              email: "example@example.test",
              emailVerified: true,
            },
            sessionId: headers.get("x-test-session") ?? id,
            expiresAt: new Date(2_000),
          }
        : null,
    );
  });
  const impersonation = createImpersonation({
    identity: { readSession },
    store: {
      insert: async (grant, event) => {
        await writeAudit(event);
        grants.set(grant.id, grant);
      },
      read: (id) => Promise.resolve(grants.get(id) ?? null),
      remove: async (id, event) => {
        if (!grants.has(id)) return false;
        await writeAudit(event);
        return grants.delete(id);
      },
    },
    authorize,
    writeAudit,
    lifetimeMs: 5_000,
    now: () => now,
  });

  return {
    impersonation,
    authorize,
    writeAudit,
    readSession,
    grants,
    advanceTo: (millis: number) => {
      now = millis;
    },
    start: async () => {
      const grant = await impersonation.start(staff, scope);
      if (!grant) throw new Error("Expected an impersonation grant");
      return grant;
    },
  };
}

describe("staff impersonation", () => {
  it("audits starting and using a grant with both account IDs", async () => {
    const { impersonation, start, authorize, writeAudit } = setup();
    const grant = await start();
    expect(grant.expiresAtMs).toBe(2_000);
    expect(grant).not.toHaveProperty("staffSessionId");
    expect(
      await impersonation.use(staff, {
        tenantId: scope.tenantId,
        grantId: grant.id,
      }),
    ).toEqual(grant);

    expect(authorize).toHaveBeenLastCalledWith({
      action: "use",
      actorAccountId: "staff",
      staffAccountId: "staff",
      ...scope,
    });
    for (const action of ["start", "use"]) {
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          outcome: "authorized",
          actorAccountId: "staff",
          staffAccountId: "staff",
          ...scope,
          grantId: grant.id,
        }),
      );
    }
  });

  it("denies creation without a staff session or tenant permission", async () => {
    const { impersonation, authorize, grants, writeAudit } = setup();
    expect(await impersonation.start(new Headers(), scope)).toBeNull();
    authorize.mockResolvedValueOnce(false);
    expect(await impersonation.start(staff, scope)).toBeNull();
    expect(grants.size).toBe(0);
    expect(writeAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "start",
        outcome: "denied",
        actorAccountId: "staff",
        ...scope,
      }),
    );
  });

  it("denies use in another tenant, by another account, or after role or session revocation", async () => {
    const { impersonation, start, authorize, readSession, writeAudit } = setup();
    const grant = await start();
    const input = { tenantId: scope.tenantId, grantId: grant.id };
    expect(await impersonation.use(staff, { ...input, tenantId: "another-tenant" })).toBeNull();
    expect(await impersonation.use(admin, input)).toBeNull();
    authorize.mockResolvedValueOnce(false);
    expect(await impersonation.use(staff, input)).toBeNull();
    readSession.mockResolvedValueOnce(null);
    expect(await impersonation.use(staff, input)).toBeNull();
    expect(writeAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "use",
        outcome: "denied",
        actorAccountId: null,
        staffAccountId: "staff",
        ...scope,
      }),
    );
  });

  it("denies use and stop after re-sign-in as the same account", async () => {
    const { impersonation, start } = setup();
    const grant = await start();
    const renewed = new Headers({
      "x-test-account": "staff",
      "x-test-session": "new-session",
    });
    expect(
      await impersonation.use(renewed, {
        tenantId: scope.tenantId,
        grantId: grant.id,
      }),
    ).toBeNull();
    expect(await impersonation.stop(renewed, grant.id)).toBe(false);
  });

  it("denies use if the grant expires while admission is audited", async () => {
    const { impersonation, start, advanceTo, writeAudit } = setup();
    const grant = await start();
    writeAudit.mockImplementationOnce(() => {
      advanceTo(2_000);
      return Promise.resolve();
    });
    expect(
      await impersonation.use(staff, {
        tenantId: scope.tenantId,
        grantId: grant.id,
      }),
    ).toBeNull();
    expect(writeAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "use", outcome: "denied" }));
  });

  it("allows the owner to stop and requires explicit permission for administrative revocation", async () => {
    const { impersonation, start, authorize, writeAudit } = setup();
    const original = await start();
    expect(await impersonation.stop(admin, original.id)).toBe(false);
    expect(await impersonation.stop(staff, original.id)).toBe(true);
    expect(
      await impersonation.use(staff, {
        tenantId: scope.tenantId,
        grantId: original.id,
      }),
    ).toBeNull();

    const grant = await start();
    authorize.mockResolvedValueOnce(false);
    expect(await impersonation.revoke(admin, grant.id)).toBe(false);
    expect(await impersonation.revoke(admin, grant.id)).toBe(true);
    expect(writeAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "revoke",
        outcome: "authorized",
        actorAccountId: "admin",
        staffAccountId: "staff",
        ...scope,
      }),
    );
    expect(
      await impersonation.use(staff, {
        tenantId: scope.tenantId,
        grantId: grant.id,
      }),
    ).toBeNull();
  });

  it("denies use when a grant is removed while admission is audited", async () => {
    const { impersonation, start, writeAudit } = setup();
    const grant = await start();
    writeAudit.mockImplementationOnce(async () => {
      await impersonation.revoke(admin, grant.id);
    });
    expect(
      await impersonation.use(staff, {
        tenantId: scope.tenantId,
        grantId: grant.id,
      }),
    ).toBeNull();
  });

  it("fails closed when audit is unavailable", async () => {
    const { impersonation, start, grants, writeAudit } = setup();
    writeAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(impersonation.start(staff, scope)).rejects.toThrow("audit unavailable");
    expect(grants.size).toBe(0);

    const grant = await start();
    writeAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(impersonation.use(staff, { tenantId: scope.tenantId, grantId: grant.id })).rejects.toBeInstanceOf(
      ImpersonationAuditError,
    );

    writeAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(impersonation.stop(staff, grant.id)).rejects.toThrow("audit unavailable");
    expect(grants.size).toBe(1);
  });

  it("audits operational errors and propagates the failure", async () => {
    const { impersonation, start, authorize, writeAudit } = setup();
    const grant = await start();
    const failure = new Error("tenant policy unavailable");
    authorize.mockRejectedValueOnce(failure);
    await expect(impersonation.use(staff, { tenantId: scope.tenantId, grantId: grant.id })).rejects.toBe(failure);
    expect(writeAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "use",
        outcome: "error",
        actorAccountId: "staff",
        staffAccountId: "staff",
        ...scope,
      }),
    );
  });
});
