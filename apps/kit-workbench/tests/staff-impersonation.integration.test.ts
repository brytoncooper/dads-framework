import { connectPostgresClient } from "@dads-framework/postgres";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { tenantIdSchema } from "@dads-framework/tenants";
import { expect, it } from "vitest";
import { z } from "zod";

import { migrate } from "../assembly/migrations.js";
import { startApp } from "../assembly/start-app.js";
import type { StarterEmail } from "../libraries/app-runtime/index.js";

const origin = "http://127.0.0.1:3000";
const password = "starter-test-password-1";
const endpoint = "/api/staff/impersonation";
type Http = Awaited<ReturnType<typeof startApp>>;

it(
  "restricts and audits staff support across real sessions and named APIs",
  { timeout: 90_000 },
  async () => {
    const postgres = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    const apps: Http[] = [];
    try {
      const databaseUrl = postgres.getConnectionUri();
      await migrate(databaseUrl);
      const emails: StarterEmail[] = [];
      const config = {
        databaseUrl,
        baseUrl: origin,
        secret: "fixture-signing-key-with-forty-characters",
        enqueueEmail: (message: StarterEmail) => {
          emails.push(message);
          return Promise.resolve();
        },
      };
      const disabled = await startApp("staff", config);
      apps.push(disabled);
      const operator = await createAccount(disabled, emails, "operator");
      const target = await createAccount(disabled, emails, "target");
      const outsider = await createAccount(disabled, emails, "outsider");
      const created = await disabled.inject({
        method: "POST",
        url: "/api/tenants",
        headers: { origin, cookie: target.cookie },
        payload: { name: "Customer tenant" },
      });
      expect(created.statusCode).toBe(201);
      const tenant = z
        .object({ data: z.object({ id: tenantIdSchema }) })
        .parse(created.json()).data;
      const enterprise = {
        staffImpersonation: {
          tenantId: tenant.id,
          staffAccountIds: [operator.id],
          revokerAccountIds: [outsider.id],
        },
      };
      const customer = await startApp("customer", { ...config, enterprise });
      apps.push(customer);
      const staff = await startApp("staff", { ...config, enterprise });
      apps.push(staff);
      const start = { action: "start", effectiveAccountId: target.id };
      expect((await command(disabled, operator.cookie, start)).statusCode).toBe(
        404,
      );
      expect((await command(customer, operator.cookie, start)).statusCode).toBe(
        404,
      );
      expect((await command(staff, undefined, start)).statusCode).toBe(404);
      expect((await command(staff, target.cookie, start)).statusCode).toBe(404);
      expect(
        (
          await command(staff, operator.cookie, {
            ...start,
            effectiveAccountId: outsider.id,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await command(staff, operator.cookie, {
            ...start,
            tenantId: tenant.id,
          })
        ).statusCode,
      ).toBe(400);

      const crossOrigin = await staff.inject({
        method: "POST",
        url: endpoint,
        headers: {
          origin: "https://elsewhere.example",
          cookie: operator.cookie,
        },
        payload: start,
      });
      expect(crossOrigin.statusCode).toBe(403);

      const first = await issue(staff, operator.cookie, start);
      const view = { action: "view-tenant", grantId: first };
      const otherSession = await signIn(staff, "operator", "198.51.100.2");
      expect((await command(staff, otherSession, view)).statusCode).toBe(404);
      const viewed = await command(staff, operator.cookie, view);
      expect(viewed.statusCode).toBe(200);
      expect(viewed.headers["cache-control"]).toBe("no-store");
      expect(viewed.json()).toEqual({
        staffAccountId: operator.id,
        effectiveAccountId: target.id,
        tenant: { id: tenant.id, name: "Customer tenant" },
      });

      const ordinaryAccess = await customer.inject({
        url: `/api/tenants/${tenant.id}/notes`,
        headers: { origin, cookie: operator.cookie },
      });
      expect(ordinaryAccess.statusCode).toBe(404);

      const stop = { action: "stop", grantId: first };
      expect((await command(staff, otherSession, stop)).statusCode).toBe(404);
      expect((await command(staff, operator.cookie, stop)).statusCode).toBe(
        200,
      );
      expect((await command(staff, operator.cookie, view)).statusCode).toBe(
        404,
      );

      const second = await issue(staff, operator.cookie, start);
      const revoke = { action: "revoke", grantId: second };
      expect((await command(staff, operator.cookie, revoke)).statusCode).toBe(
        404,
      );
      expect((await command(staff, outsider.cookie, revoke)).statusCode).toBe(
        200,
      );
      expect(
        (await command(staff, operator.cookie, { ...view, grantId: second }))
          .statusCode,
      ).toBe(404);

      expect(await readAuditEvents(databaseUrl)).toEqual(
        expect.arrayContaining([
          audit("start", "authorized", first, operator.id),
          audit("use", "authorized", first, operator.id),
          audit("use", "denied", first, operator.id),
          audit("stop", "authorized", first, operator.id),
          audit("revoke", "authorized", second, outsider.id),
        ]),
      );
      function audit(
        action: string,
        outcome: string,
        grantId: string,
        actorAccountId: string,
      ) {
        const event: unknown = expect.objectContaining({
          action,
          outcome,
          grantId,
          actorAccountId,
          staffAccountId: operator.id,
          effectiveAccountId: target.id,
          tenantId: tenant.id,
        });
        return { event };
      }
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await postgres.stop();
    }
  },
);

async function createAccount(app: Http, emails: StarterEmail[], name: string) {
  const email = `${name}@example.test`;
  const created = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin },
    payload: { email, name, password },
  });
  expect(created.statusCode).toBe(200);
  const verify = emails.find(
    (entry) => entry.to === email && entry.kind === "verify-email",
  );
  if (verify === undefined) throw new Error("Missing verification email.");
  const link = new URL(verify.url);
  const verified = await app.inject({
    url: link.pathname + link.search,
    headers: { origin },
  });
  expect([200, 302]).toContain(verified.statusCode);
  const cookie = await signIn(app, name);
  const session = await app.inject({
    url: "/api/auth/get-session",
    headers: { origin, cookie },
  });
  const { account } = z
    .object({ account: z.object({ id: z.string() }) })
    .parse(session.json());
  return { id: account.id, cookie };
}

async function signIn(app: Http, name: string, ip = "198.51.100.1") {
  const signedIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin, "x-forwarded-for": ip },
    payload: { email: `${name}@example.test`, password },
  });
  expect(signedIn.statusCode).toBe(200);
  const raw = signedIn.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const cookie = cookies
    .flatMap((value) => value?.split(";")[0] ?? [])
    .join("; ");
  expect(cookie).not.toBe("");
  return cookie;
}

function command(app: Http, cookie: string | undefined, payload: object) {
  return app.inject({
    method: "POST",
    url: endpoint,
    headers: { origin, ...(cookie === undefined ? {} : { cookie }) },
    payload,
  });
}

async function issue(app: Http, cookie: string, payload: object) {
  const response = await command(app, cookie, payload);
  expect(response.statusCode).toBe(201);
  expect(response.headers["set-cookie"]).toBeUndefined();
  return z.object({ id: z.uuid() }).parse(response.json()).id;
}

async function readAuditEvents(databaseUrl: string) {
  const client = await connectPostgresClient(databaseUrl);
  try {
    const result = await client.query<{ event: unknown }>(
      "SELECT event FROM identity_staff_impersonation_audit",
    );
    return result.rows;
  } finally {
    await client.end();
  }
}
