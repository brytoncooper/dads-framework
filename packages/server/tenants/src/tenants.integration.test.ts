import { access, accessModel, entityHandle } from "@dads-framework/access";
import type {
  AuditLogScope,
  AuditTriggerConfiguration,
} from "@dads-framework/audit";
import type {
  FeatureFlagContext,
  TenantDirectory,
} from "@dads-framework/feature-flags";
import { runNodePgMigrations } from "@dads-framework/migrations";
import {
  createPostgresConnection,
  type PostgresConnection,
} from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  relationshipSchemaMigration,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createTenantAccess,
  createTenantDirectory,
  tenantAuditConfiguration,
  TenantInvitationUnavailableError,
  tenantMigrations,
  TenantUnavailableError,
  Tenants,
} from "./index.js";

const account = entityHandle({ wireName: "user", idSchema: z.string().min(1) });
const definitions = createTenantAccess(account);
const accountDefinition = access(account, {
  roles: {},
  permissions: () => ({}),
});
const model = accessModel([accountDefinition, definitions.tenant]);

describe("two tenants on Postgres", () => {
  const cleanup: (() => Promise<void>)[] = [];
  let tenants: Tenants;
  let directory: TenantDirectory;
  let database: PostgresConnection;
  let duringAuthorization: (() => Promise<void>) | undefined;
  const clock = { now: new Date("2026-11-20T06:00:00Z") };

  beforeAll(async () => {
    const postgres = await startUnmigratedTestPostgres();
    cleanup.push(postgres.stop);
    await postgres.pool.query(relationshipSchemaMigration.sql);
    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: {
        root: tenantMigrations.directory,
        sources: [
          {
            root: ".",
            files: /^[^/]+\.migration\.ts$/,
            owner: "tenants",
            required: true,
          },
        ],
        moduleAliases: {},
      },
    });
    database = createPostgresConnection(
      { connectionString: postgres.connectionString, schema: {} },
      { error: () => undefined },
    );
    cleanup.unshift(database.close);
    const backend = new PostgresAuthorization({
      model,
      namespace: "tenant_isolation",
      executor: database.pool,
    });
    tenants = new Tenants({
      database: database.drizzle,
      access: definitions,
      authorizationAt: (tx) => {
        const authorization = backend.inDrizzleTransaction(tx);
        return {
          async check(query) {
            const allowed = await authorization.check(query);
            await duringAuthorization?.();
            return allowed;
          },
          lookupResources: (query) => authorization.lookupResources(query),
        };
      },
      changes: new TransactionalAccessChanges(backend, database.drizzle),
      now: () => clock.now,
    });
    directory = createTenantDirectory(database.drizzle);
  }, 60_000);

  afterAll(async () => {
    for (const stop of cleanup) await stop();
  });

  it("allows each owner to list, read, and rename only their own tenant", async () => {
    const north = await tenants.create("nora", "North");
    const south = await tenants.create("sam", "South");

    await expect(tenants.list("nora")).resolves.toEqual([north]);
    await expect(tenants.list("sam")).resolves.toEqual([south]);
    await expect(tenants.list("visitor")).resolves.toEqual([]);
    await expect(tenants.context("nora", south.id)).rejects.toBeInstanceOf(
      TenantUnavailableError,
    );
    await expect(
      tenants.rename("nora", south.id, "Changed"),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.memberships.roster("sam", north.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.invitations.issue("nora", south.id, "user@example.test"),
    ).rejects.toBeInstanceOf(TenantUnavailableError);

    await expect(
      tenants.rename("nora", north.id, "North Team"),
    ).resolves.toEqual({ ...north, name: "North Team" });
    const context = await tenants.context("sam", south.id);
    const audience: FeatureFlagContext = context.audience;
    const auditScope: AuditLogScope = context.auditScope;
    const triggerOptions: AuditTriggerConfiguration = tenantAuditConfiguration;
    expect(context.tenant).toEqual(south);
    expect(audience).toEqual({ kind: "tenant", tenantId: south.id });
    expect(auditScope).toEqual({
      kind: "application",
      values: { tenant_id: south.id },
    });
    expect(triggerOptions.tables["tenant"]?.scopeColumns?.["tenant_id"]).toBe(
      "id",
    );
    await expect(
      directory.findActiveTenants([south.id, "not-a-tenant"]),
    ).resolves.toEqual([south]);
  });

  it("requires a verified recipient, consumes the invitation once, and grants only the invited tenant", async () => {
    const project = await tenants.create("pat", "Project");
    const another = await tenants.create("alex", "Another");
    const { token } = await tenants.invitations.issue(
      "pat",
      project.id,
      "guest@example.test",
    );
    const guest = {
      id: "guest",
      email: "Guest@example.test",
      emailVerified: true,
    };

    await expect(
      tenants.invitations.accept(token, { ...guest, emailVerified: false }),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    await expect(
      tenants.invitations.accept(token, {
        ...guest,
        email: "other@example.test",
      }),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    await expect(tenants.list(guest.id)).resolves.toEqual([]);
    await expect(tenants.invitations.accept(token, guest)).resolves.toBe(
      project.id,
    );
    await expect(
      tenants.invitations.accept(token, guest),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);

    await expect(tenants.list(guest.id)).resolves.toEqual([project]);
    await expect(tenants.context(guest.id, another.id)).rejects.toBeInstanceOf(
      TenantUnavailableError,
    );
    await expect(
      tenants.rename(guest.id, project.id, "Changed"),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.memberships.changeRole(guest.id, project.id, guest.id, "admin"),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.memberships.roster("pat", project.id),
    ).resolves.toEqual([
      { tenantId: project.id, accountId: guest.id, role: "member" },
      { tenantId: project.id, accountId: "pat", role: "owner" },
    ]);

    await tenants.memberships.changeRole("pat", project.id, guest.id, "admin");
    await expect(
      tenants.memberships.roster(guest.id, project.id),
    ).resolves.toHaveLength(2);
    await expect(
      tenants.memberships.permissions("pat", project.id, guest.id),
    ).resolves.toEqual({
      role: "admin",
      view: true,
      manageMembers: true,
      manageTenant: false,
    });
    await expect(
      tenants.memberships.permissions(guest.id, project.id, "pat"),
    ).resolves.toEqual({
      role: "owner",
      view: true,
      manageMembers: true,
      manageTenant: true,
    });
    await expect(
      tenants.memberships.removeMember(guest.id, project.id, "pat"),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await tenants.memberships.removeMember("pat", project.id, guest.id);
    await expect(
      tenants.memberships.permissions("pat", project.id, guest.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(tenants.list(guest.id)).resolves.toEqual([]);
    await expect(tenants.context(guest.id, project.id)).rejects.toBeInstanceOf(
      TenantUnavailableError,
    );
  });

  it("commits one membership when the same invite arrives concurrently", async () => {
    const tenant = await tenants.create("jordan", "Concurrent");
    const { token } = await tenants.invitations.issue(
      "jordan",
      tenant.id,
      "race@example.test",
    );
    const account = {
      id: "racer",
      email: "race@example.test",
      emailVerified: true,
    };
    const results = await Promise.allSettled([
      tenants.invitations.accept(token, account),
      tenants.invitations.accept(token, account),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: tenant.id },
    ]);
    await expect(tenants.list(account.id)).resolves.toEqual([tenant]);
    await expect(
      tenants.memberships.roster("jordan", tenant.id),
    ).resolves.toHaveLength(2);
  });

  it("checks the locked invitation tenant and verified recipient before granting membership", async () => {
    const tenant = await tenants.create("sso-owner", "SSO Required");
    const invite = await tenants.invitations.issue(
      "sso-owner",
      tenant.id,
      "proof@example.test",
    );
    const account = {
      id: "proof-recipient",
      email: "Proof@example.test",
      emailVerified: true,
    };
    await expect(
      tenants.invitations.accept(invite.token, account, async (recipient) => {
        expect(recipient).toEqual({
          tenantId: tenant.id,
          account: { ...account, email: "proof@example.test" },
        });
        await expect(
          database.pool.query(
            "SELECT tenant_id FROM tenant_invitation WHERE tenant_id = $1 FOR UPDATE NOWAIT",
            [tenant.id],
          ),
        ).rejects.toMatchObject({ code: "55P03" });
        return false;
      }),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    await expect(tenants.list(account.id)).resolves.toEqual([]);
    await expect(
      tenants.invitations.accept(
        invite.token,
        account,
        ({ tenantId, account: verified }) =>
          Promise.resolve(tenantId === tenant.id && verified.id === account.id),
      ),
    ).resolves.toBe(tenant.id);
    await expect(tenants.list(account.id)).resolves.toEqual([tenant]);
  });

  it("holds the inviter's membership through the acceptance authorization check", async () => {
    const tenant = await tenants.create("casey", "Lock proof");
    const first = await tenants.invitations.issue(
      "casey",
      tenant.id,
      "lead@example.test",
    );
    const admin = {
      id: "lead",
      email: "lead@example.test",
      emailVerified: true,
    };
    await tenants.invitations.accept(first.token, admin);
    await tenants.memberships.changeRole("casey", tenant.id, admin.id, "admin");
    const invite = await tenants.invitations.issue(
      admin.id,
      tenant.id,
      "guest-lock@example.test",
    );

    const probe = async () => {
      // Role revocation needs this exact exclusive row lock.
      await expect(
        database.pool.query(
          "SELECT account_id FROM tenant_membership WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE NOWAIT",
          [tenant.id, admin.id],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    };
    duringAuthorization = probe;
    try {
      await expect(
        tenants.invitations.accept(invite.token, {
          id: "lock-guest",
          email: "guest-lock@example.test",
          emailVerified: true,
        }),
      ).resolves.toBe(tenant.id);
    } finally {
      duringAuthorization = undefined;
    }
  });

  it("rechecks expiry after the issuer authorization completes", async () => {
    const tenant = await tenants.create("riley", "Expiry during authorization");
    const invite = await tenants.invitations.issue(
      "riley",
      tenant.id,
      "late@example.test",
    );
    const priorTime = clock.now;
    duringAuthorization = () => {
      clock.now = invite.expiresAt;
      return Promise.resolve();
    };
    try {
      await expect(
        tenants.invitations.accept(invite.token, {
          id: "late",
          email: "late@example.test",
          emailVerified: true,
        }),
      ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    } finally {
      clock.now = priorTime;
      duringAuthorization = undefined;
    }
    await expect(tenants.list("late")).resolves.toEqual([]);
  });

  it("refuses expired invites and revokes outstanding invite authority when an admin loses access", async () => {
    const tenant = await tenants.create("morgan", "Workspace");
    const first = await tenants.invitations.issue(
      "morgan",
      tenant.id,
      "admin@example.test",
    );
    const admin = {
      id: "taylor",
      email: "admin@example.test",
      emailVerified: true,
    };
    await tenants.invitations.accept(first.token, admin);
    await tenants.memberships.changeRole(
      "morgan",
      tenant.id,
      admin.id,
      "admin",
    );

    const expired = await tenants.invitations.issue(
      "morgan",
      tenant.id,
      "expiry@example.test",
    );
    const forwarded = await tenants.invitations.issue(
      admin.id,
      tenant.id,
      "next@example.test",
    );
    await tenants.memberships.removeMember("morgan", tenant.id, admin.id);
    await expect(
      tenants.invitations.accept(forwarded.token, {
        id: "next",
        email: "next@example.test",
        emailVerified: true,
      }),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);

    clock.now = expired.expiresAt;
    await expect(
      tenants.invitations.accept(expired.token, {
        id: "expiry",
        email: "expiry@example.test",
        emailVerified: true,
      }),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    await expect(tenants.list("expiry")).resolves.toEqual([]);
  });
});
