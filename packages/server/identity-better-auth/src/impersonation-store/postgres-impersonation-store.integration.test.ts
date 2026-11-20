import { createImpersonation } from "@dads-framework/identity/impersonation";
import { runNodePgMigrations } from "@dads-framework/migrations";
import {
  startUnmigratedTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresImpersonationStore } from "./index.js";

let postgres: TestPostgres | undefined;

beforeAll(async () => {
  postgres = await startUnmigratedTestPostgres({ attributed: false });
  await runNodePgMigrations({
    databaseUrl: postgres.connectionString,
    workspace: {
      root: fileURLToPath(new URL("../..", import.meta.url)),
      sources: [
        {
          root: "src/lib/migrations",
          files: /^src\/lib\/migrations\/[^/]+\.migration\.ts$/u,
          required: true,
          owner: "identity-better-auth",
        },
      ],
      moduleAliases: {},
    },
  });
}, 120_000);

afterAll(async () => {
  await postgres?.stop();
});

it("commits grant mutations and their audit rows together on real PostgreSQL", async () => {
  if (!postgres) throw new Error("Expected a test database");
  const { pool } = postgres;
  const staff = new Headers();
  const tenantId = "tenant";
  const scope = { tenantId, effectiveAccountId: "customer" };
  const adapter = createPostgresImpersonationStore(pool);
  const impersonation = createImpersonation({
    ...adapter,
    identity: {
      readSession: () =>
        Promise.resolve({
          account: {
            id: "staff",
            email: "staff@example.test",
            emailVerified: true,
          },
          sessionId: "issuing-session",
          expiresAt: new Date(Date.now() + 60_000),
        }),
    },
    authorize: () => Promise.resolve(true),
    lifetimeMs: 30_000,
  });

  const grant = await impersonation.start(staff, scope);
  if (!grant) throw new Error("Expected a staff grant");
  expect(
    await impersonation.use(staff, { grantId: grant.id, tenantId }),
  ).toEqual(grant);
  await pool.query(`ALTER TABLE identity_staff_impersonation_audit ADD CONSTRAINT reject_success
    CHECK (event->>'outcome' <> 'authorized') NOT VALID`);
  await expect(impersonation.start(staff, scope)).rejects.toThrow(
    "reject_success",
  );
  await expect(impersonation.revoke(staff, grant.id)).rejects.toThrow(
    "reject_success",
  );

  const remaining = await pool.query(
    "SELECT id FROM identity_staff_impersonation_grants",
  );
  expect(remaining.rows).toEqual([{ id: grant.id }]);
  await pool.query(
    "ALTER TABLE identity_staff_impersonation_audit DROP CONSTRAINT reject_success",
  );
  expect(await impersonation.revoke(staff, grant.id)).toBe(true);
  expect(
    await impersonation.use(staff, { grantId: grant.id, tenantId }),
  ).toBeNull();

  const audit = await pool.query(
    `
    SELECT event->>'action' AS action, event->>'outcome' AS outcome,
           event->>'actorAccountId' AS actor, event->>'effectiveAccountId' AS effective
    FROM identity_staff_impersonation_audit WHERE event->>'grantId' = $1 ORDER BY id
  `,
    [grant.id],
  );
  expect(audit.rows).toEqual([
    {
      action: "start",
      outcome: "authorized",
      actor: "staff",
      effective: "customer",
    },
    {
      action: "use",
      outcome: "authorized",
      actor: "staff",
      effective: "customer",
    },
    {
      action: "revoke",
      outcome: "error",
      actor: "staff",
      effective: "customer",
    },
    {
      action: "revoke",
      outcome: "authorized",
      actor: "staff",
      effective: "customer",
    },
    { action: "use", outcome: "denied", actor: "staff", effective: null },
  ]);
});
