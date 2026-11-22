import { actor, compileAccess } from "@dads-framework/access";
import type {
  ScimDirectory,
  ScimGroupDirectory,
  ScimUserData,
} from "@dads-framework/identity/scim";
import { runNodePgMigrations } from "@dads-framework/migrations";
import { createPostgresConnection } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import {
  PostgresAuthorization,
  relationshipSchemaMigration,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createTenantAccess,
  createTenantScimDirectory,
  createTenantScimGroupDirectory,
  TenantInvitationUnavailableError,
  tenantMigrations,
  TenantUnavailableError,
  Tenants,
  type TenantId,
  type TenantsOptions,
} from "./index.js";

const account = actor("user", { id: z.string().min(1) });
const definitions = createTenantAccess(account);
const model = compileAccess([account, definitions.tenant]);
const accountSession = {
  id: "member",
  email: "member@example.test",
  emailVerified: true,
};

describe("tenant SCIM directory on Postgres", () => {
  const cleanup: (() => Promise<void>)[] = [];
  let tenants: Tenants;
  let scim: ScimDirectory;
  let groups: ScimGroupDirectory;
  let options: TenantsOptions;

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
    const connection = createPostgresConnection(
      { connectionString: postgres.connectionString, schema: {} },
      { error: () => undefined },
    );
    cleanup.unshift(connection.close);
    const backend = new PostgresAuthorization({
      model,
      namespace: "tenant_scim",
      executor: connection.pool,
    });
    options = {
      database: connection.drizzle,
      access: definitions,
      authorizationAt: (tx) => backend.inDrizzleTransaction(tx),
      changes: new TransactionalAccessChanges(backend, connection.drizzle),
    };
    tenants = new Tenants(options);
    scim = createTenantScimDirectory(options);
    groups = createTenantScimGroupDirectory(options);
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  async function provision(tenantId: TenantId, data: ScimUserData) {
    const user = await scim.create(tenantId, data);
    if (user === "conflict") throw new Error("Unexpected SCIM conflict");
    return user;
  }

  async function grant(owner: string, tenantId: TenantId) {
    const invite = await tenants.invitations.issue(
      owner,
      tenantId,
      accountSession.email,
    );
    await tenants.invitations.accept(invite.token, accountSession);
  }

  it("isolates lookup, mutations, uniqueness and filtered counts by tenant", async () => {
    const north = await tenants.create("north", "North");
    const south = await tenants.create("south", "South");
    const profile = {
      userName: "Alice",
      active: true,
      externalId: "DirectoryAlice",
      displayName: "Alice",
      name: { givenName: "Alice" },
      emails: [{ value: "ALICE@example.test" }],
    };
    const alice = await provision(north.id, profile);
    const other = await provision(south.id, { ...profile, userName: "ALICE" });
    const bob = await provision(north.id, { userName: "Bob", active: true });
    await expect(scim.get(south.id, alice.id)).resolves.toBeNull();
    await expect(scim.get(north.id, "invalid")).resolves.toBeNull();
    await expect(
      scim.update(south.id, alice.id, (user) => ({ ...user, active: false })),
    ).resolves.toBeNull();
    await expect(scim.delete(south.id, alice.id)).resolves.toBe(false);
    await expect(scim.get(north.id, alice.id)).resolves.toEqual(alice);
    await expect(
      scim.create(north.id, { userName: "aLICE", active: false }),
    ).resolves.toBe("conflict");
    await expect(
      scim.update(north.id, bob.id, (user) => ({ ...user, userName: "ALICE" })),
    ).resolves.toBe("conflict");
    await expect(scim.get(north.id, bob.id)).resolves.toEqual(bob);
    const filter = {
      attribute: "emails.value",
      value: "alice@example.test",
    } as const;
    await expect(
      scim.list(north.id, { startIndex: 1, count: 1, filter }),
    ).resolves.toEqual({ users: [alice], totalResults: 1 });
    await expect(
      scim.list(south.id, { startIndex: 1, count: 1, filter }),
    ).resolves.toEqual({ users: [other], totalResults: 1 });
    await expect(
      scim.list(north.id, { startIndex: 2, count: 1, filter }),
    ).resolves.toEqual({ users: [], totalResults: 1 });
    await expect(
      scim.list(north.id, { startIndex: 1, count: 0 }),
    ).resolves.toEqual({ users: [], totalResults: 2 });
  });

  it("requires an explicit owner link and revokes only the linked tenant", async () => {
    const workspace = await tenants.create("owner", "Managed");
    const other = await tenants.create("other", "Other");
    const profile = {
      userName: accountSession.email,
      emails: [{ value: accountSession.email }],
      externalId: accountSession.id,
      active: true,
    };
    const user = await provision(workspace.id, profile);
    await expect(tenants.list(accountSession.id)).resolves.toEqual([]);
    await expect(
      tenants.bindScimUser("owner", workspace.id, user.id, accountSession.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await grant("owner", workspace.id);
    await grant("other", other.id);
    await expect(
      tenants.bindScimUser("owner", workspace.id, user.id, "owner"),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.bindScimUser("other", workspace.id, user.id, accountSession.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.bindScimUser("other", other.id, user.id, accountSession.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);

    await expect(
      scim.update(workspace.id, user.id, (current) => ({
        ...current,
        active: false,
      })),
    ).resolves.toMatchObject({ active: false });
    await expect(
      tenants.context(accountSession.id, workspace.id),
    ).resolves.toMatchObject({ tenant: workspace });
    await scim.update(workspace.id, user.id, (current) => ({
      ...current,
      active: true,
    }));
    await tenants.bindScimUser(
      "owner",
      workspace.id,
      user.id,
      accountSession.id,
    );
    const spare = await provision(workspace.id, {
      userName: "spare",
      active: true,
    });
    await expect(
      tenants.bindScimUser("owner", workspace.id, spare.id, accountSession.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    const pending = await tenants.invitations.issue(
      "owner",
      workspace.id,
      accountSession.email,
    );
    await scim.update(workspace.id, user.id, (current) => ({
      ...current,
      active: false,
    }));

    await expect(
      tenants.context(accountSession.id, workspace.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(tenants.list(accountSession.id)).resolves.toContainEqual(
      other,
    );
    await expect(
      tenants.invitations.accept(pending.token, accountSession),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    await scim.update(workspace.id, user.id, (current) => ({
      ...current,
      active: true,
    }));
    await expect(
      tenants.context(accountSession.id, workspace.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await grant("owner", workspace.id);

    await expect(scim.delete(workspace.id, user.id)).resolves.toBe(true);
    await expect(scim.delete(workspace.id, user.id)).resolves.toBe(false);
    await expect(scim.get(workspace.id, user.id)).resolves.toBeNull();
    await expect(
      tenants.context(accountSession.id, workspace.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    const recreated = await provision(workspace.id, profile);
    expect(recreated.id).not.toBe(user.id);
    await expect(
      tenants.invitations.accept(pending.token, accountSession),
    ).rejects.toBeInstanceOf(TenantInvitationUnavailableError);
    await expect(
      tenants.bindScimUser(
        "other",
        workspace.id,
        recreated.id,
        accountSession.id,
      ),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await tenants.bindScimUser(
      "owner",
      workspace.id,
      recreated.id,
      accountSession.id,
    );
    await expect(
      tenants.context(accountSession.id, workspace.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await grant("owner", workspace.id);
    await expect(
      tenants.context(accountSession.id, workspace.id),
    ).resolves.toMatchObject({ tenant: workspace });
    await expect(scim.get(workspace.id, user.id)).resolves.toBeNull();
  });

  it("isolates group resources and atomically removes deleted user references", async () => {
    const tenant = await tenants.create("group-owner", "Group Tenant");
    const foreign = await tenants.create("foreign-owner", "Foreign Tenant");
    const local = await provision(tenant.id, {
      userName: "local",
      active: true,
    });
    const unrelated = await provision(foreign.id, {
      userName: "foreign",
      active: true,
    });
    const attributes = {
      displayName: "Directory Admins",
      externalId: "group-1",
    };
    const members = [{ value: local.id }];
    await expect(
      groups.create(tenant.id, {
        ...attributes,
        members: [{ value: unrelated.id }],
      }),
    ).resolves.toBe("invalidMember");
    await expect(
      groups.list(tenant.id, { startIndex: 1, count: 0 }),
    ).resolves.toEqual({ groups: [], totalResults: 0 });
    const group = await groups.create(tenant.id, { ...attributes, members });
    if (typeof group === "string") throw new Error("Expected a SCIM group");
    await expect(groups.get(tenant.id, group.id)).resolves.toEqual(group);
    await expect(groups.get(foreign.id, group.id)).resolves.toBeNull();
    await expect(
      groups.list(foreign.id, { startIndex: 1, count: 1 }),
    ).resolves.toEqual({ groups: [], totalResults: 0 });
    await expect(
      groups.list(tenant.id, {
        startIndex: 1,
        count: 1,
        filter: { attribute: "displayName", value: "directory admins" },
      }),
    ).resolves.toEqual({ groups: [group], totalResults: 1 });
    await expect(
      groups.update(foreign.id, group.id, (data) => ({
        ...data,
        displayName: "Changed",
      })),
    ).resolves.toBeNull();
    await expect(groups.delete(foreign.id, group.id)).resolves.toBe(false);
    await expect(
      groups.update(tenant.id, group.id, (data) => ({
        ...data,
        displayName: "Changed",
        members: [...members, { value: unrelated.id }],
      })),
    ).resolves.toBe("invalidMember");
    await expect(groups.get(tenant.id, group.id)).resolves.toEqual(group);
    await expect(tenants.context("local", tenant.id)).rejects.toBeInstanceOf(
      TenantUnavailableError,
    );

    await expect(scim.delete(tenant.id, local.id)).resolves.toBe(true);
    await expect(groups.get(tenant.id, group.id)).resolves.toMatchObject({
      ...attributes,
      members: [],
    });
    await expect(
      groups.update(tenant.id, group.id, (data) => ({ ...data, members })),
    ).resolves.toBe("invalidMember");
    await expect(groups.delete(tenant.id, group.id)).resolves.toBe(true);
    await expect(groups.get(tenant.id, group.id)).resolves.toBeNull();
  });

  it("rolls back profile, membership and relationship on deprovisioning failure", async () => {
    const tenant = await tenants.create("rollback", "Rollback");
    await grant("rollback", tenant.id);
    const user = await provision(tenant.id, {
      userName: "rollback",
      active: true,
    });
    await tenants.bindScimUser(
      "rollback",
      tenant.id,
      user.id,
      accountSession.id,
    );
    const failure = createTenantScimDirectory({
      ...options,
      changes: {
        async enqueue(entries, tx) {
          await options.changes.enqueue(entries, tx);
          throw new Error("Rollback probe");
        },
      },
    });

    await expect(failure.delete(tenant.id, user.id)).rejects.toThrow(
      "Rollback probe",
    );
    await expect(scim.get(tenant.id, user.id)).resolves.toEqual(user);
    await expect(
      tenants.context(accountSession.id, tenant.id),
    ).resolves.toMatchObject({ tenant });
    await expect(
      tenants.memberships.roster("rollback", tenant.id),
    ).resolves.toContainEqual({
      tenantId: tenant.id,
      accountId: accountSession.id,
      role: "member",
    });
  });
});
