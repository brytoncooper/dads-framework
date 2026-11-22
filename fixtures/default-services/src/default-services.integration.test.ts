import { actor, compileAccess } from "@dads-framework/access";
import { createBetterAuthIdentity } from "@dads-framework/identity-better-auth";
import { runNodePgMigrations } from "@dads-framework/migrations";
import { readAppliedNodePgJournal } from "@dads-framework/migrations/journal-status";
import { createPostgresConnection } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import {
  PostgresAuthorization,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import {
  createTenantAccess,
  TenantUnavailableError,
  Tenants,
} from "@dads-framework/tenants";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";

it("runs the documented migration and preserves default identity and tenant data on replay", async () => {
  const database = await startUnmigratedTestPostgres();
  const connection = createPostgresConnection(
    { connectionString: database.connectionString, schema: {} },
    console,
  );
  try {
    const migrate = () =>
      runNodePgMigrations({
        databaseUrl: database.connectionString,
        workspace: {
          root: fileURLToPath(new URL("..", import.meta.url)),
          sources: [
            {
              root: "migrations",
              owner: "default-services",
              files: /^migrations\/[^/]+\.migration\.ts$/,
              required: true,
            },
          ],
          moduleAliases: {},
        },
      });
    await migrate();
    const journal = await readAppliedNodePgJournal(database.pool);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.journalName).toBe(
      "20261120000000_default_services.migration",
    );
    expect(journal[0]?.ranAt).toBeInstanceOf(Date);
    expect(journal[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const origin = "http://127.0.0.1:3000";
    const email = "member@example.test";
    const password = "fixture-member-password";
    let verificationUrl: string | undefined;
    const identity = createBetterAuthIdentity({
      database: connection,
      baseUrl: origin,
      secret: "default-services-fixture-secret-0123456789",
      canInvite: () => Promise.resolve(false),
      enqueueEmail: (message) => {
        if (message.kind === "verify-email") verificationUrl = message.url;
        return Promise.resolve();
      },
    });
    const post = (path: string, body: object) =>
      identity.handle(
        new Request(origin + "/api/auth" + path, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect(
      (await post("/sign-up/email", { name: "Member", email, password }))
        .status,
    ).toBe(200);
    await expect.poll(() => verificationUrl).toBeDefined();
    if (verificationUrl === undefined)
      throw new Error("Verification email was not sent.");
    expect((await identity.handle(new Request(verificationUrl))).status).toBe(
      302,
    );
    const signedIn = await post("/sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);
    const headers = new Headers({
      cookie: signedIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; "),
    });
    const session = await identity.readSession(headers);
    if (!session?.account.emailVerified)
      throw new Error("Expected a verified account.");

    const account = actor("account", { id: z.string() });
    const tenantAccess = createTenantAccess(account);
    const authorization = new PostgresAuthorization({
      model: compileAccess([account, tenantAccess.tenant], {
        allowLookupResourcesOn: [tenantAccess.tenant],
      }),
      namespace: "default-services",
      executor: connection.pool,
    });
    const tenants = new Tenants({
      database: connection.drizzle,
      access: tenantAccess,
      authorizationAt: (tx) => authorization.inDrizzleTransaction(tx),
      changes: new TransactionalAccessChanges(
        authorization,
        connection.drizzle,
      ),
    });
    const tenant = await tenants.create("fixture-owner", "Default services");
    const invite = await tenants.invitations.issue(
      "fixture-owner",
      tenant.id,
      email,
    );
    await expect(
      tenants.context(session.account.id, tenant.id),
    ).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(
      tenants.invitations.accept(invite.token, session.account),
    ).resolves.toBe(tenant.id);

    await migrate();
    expect(await readAppliedNodePgJournal(database.pool)).toEqual(journal);
    expect((await identity.readSession(headers))?.account.id).toBe(
      session.account.id,
    );
    expect(
      (await tenants.context(session.account.id, tenant.id)).tenant,
    ).toEqual(tenant);
  } finally {
    await connection.close();
    await database.stop();
  }
}, 120_000);
