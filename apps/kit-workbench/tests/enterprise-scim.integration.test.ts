import { createHash, randomBytes, randomUUID } from "node:crypto";
import { connectPostgresClient } from "@dads-framework/postgres";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { expect, it } from "vitest";
import { z } from "zod";

import { migrate } from "../assembly/migrations.js";
import { startApp } from "../assembly/start-app.js";

const origin = "http://127.0.0.1:3000";
const users = "/scim/v2/Users";
const groups = "/scim/v2/Groups";
const userResponse = z.object({ id: z.uuid(), active: z.boolean() });

it(
  "mounts SCIM only for configured customer APIs and confines mutations to the bearer tenant",
  { timeout: 90_000 },
  async () => {
    const postgres = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    const apps: Awaited<ReturnType<typeof startApp>>[] = [];
    try {
      const databaseUrl = postgres.getConnectionUri();
      await migrate(databaseUrl);
      const first = tenantIdSchema.parse(randomUUID());
      const second = tenantIdSchema.parse(randomUUID());
      await seedTenants(databaseUrl, first, second);
      const configuration = {
        databaseUrl,
        baseUrl: origin,
        secret: "fixture-signing-key-with-forty-characters",
        enqueueEmail: () => Promise.resolve(),
      };
      const sharedDigest = scimConfiguration(first).config.tokenSha256;
      await expect(
        startApp("customer", {
          ...configuration,
          enterprise: {
            scim: [
              { tenantId: first, tokenSha256: sharedDigest },
              { tenantId: second, tokenSha256: sharedDigest },
            ],
          },
        }),
      ).rejects.toMatchObject({
        cause: new Error("SCIM credential digests must be unique."),
      });
      const disabled = await startApp("customer", configuration);
      apps.push(disabled);
      expect((await disabled.inject({ url: users })).statusCode).toBe(404);
      const baselineSignup = await disabled.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { origin, host: new URL(origin).host },
        payload: {
          email: "starter-member@example.test",
          name: "Starter Member",
          password: "starter-test-password-1",
        },
      });
      expect(baselineSignup.statusCode).toBe(200);

      const alpha = scimConfiguration(first);
      const beta = scimConfiguration(second);
      const rotated = scimConfiguration(first);
      const enterprise = { scim: [alpha.config, beta.config, rotated.config] };
      const customer = await startApp("customer", {
        ...configuration,
        enterprise,
      });
      apps.push(customer);
      const staff = await startApp("staff", { ...configuration, enterprise });
      apps.push(staff);
      expect(
        (await staff.inject({ url: users, headers: alpha.headers })).statusCode,
      ).toBe(404);
      expect((await customer.inject({ url: users })).statusCode).toBe(401);
      const unknown = scimConfiguration(first);
      expect(
        (await customer.inject({ url: users, headers: unknown.headers }))
          .statusCode,
      ).toBe(401);

      const created = await customer.inject({
        method: "POST",
        url: users,
        headers: alpha.headers,
        payload: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "directory-user@example.test",
        },
      });
      expect(created.statusCode).toBe(201);
      const { id } = userResponse.parse(created.json());
      const url = `${users}/${id}`;
      expect(created.headers.location).toBe(`${origin}${url}`);
      expect(
        (await customer.inject({ url, headers: rotated.headers })).statusCode,
      ).toBe(200);
      expect(
        (await customer.inject({ url, headers: beta.headers })).statusCode,
      ).toBe(404);
      expect(
        (
          await customer.inject({
            method: "DELETE",
            url,
            headers: beta.headers,
          })
        ).statusCode,
      ).toBe(404);

      await proveGroups(customer, id, alpha.headers, beta.headers);

      const patched = await customer.inject({
        method: "PATCH",
        url,
        headers: alpha.headers,
        payload: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      });
      expect(patched.statusCode).toBe(200);
      expect(userResponse.parse(patched.json())).toEqual({ id, active: false });
      expect(
        (
          await customer.inject({
            method: "DELETE",
            url,
            headers: alpha.headers,
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await customer.inject({ url, headers: alpha.headers })).statusCode,
      ).toBe(404);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await postgres.stop();
    }
  },
);

function scimConfiguration(tenantId: z.output<typeof tenantIdSchema>) {
  const token = randomBytes(32).toString("base64url");
  return {
    config: {
      tenantId,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    },
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/scim+json",
    },
  };
}

async function proveGroups(
  customer: Awaited<ReturnType<typeof startApp>>,
  memberId: string,
  alpha: Record<string, string>,
  beta: Record<string, string>,
) {
  const payload = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName: "Engineering",
    members: [{ value: memberId }],
  };
  const created = await customer.inject({
    method: "POST",
    url: groups,
    headers: alpha,
    payload,
  });
  expect(created.statusCode).toBe(201);
  const { id } = z.object({ id: z.uuid() }).parse(created.json());
  expect(
    (await customer.inject({ url: `${groups}/${id}`, headers: beta }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await customer.inject({
        method: "POST",
        url: groups,
        headers: beta,
        payload,
      })
    ).statusCode,
  ).toBe(400);
}

async function seedTenants(databaseUrl: string, first: string, second: string) {
  const client = await connectPostgresClient(databaseUrl);
  try {
    await client.query("SELECT set_config('dads.audit_actor', $1, false)", [
      JSON.stringify({
        kind: "system",
        id: "scim-fixture",
        requestId: "scim-fixture-seed",
      }),
    ]);
    await client.query(
      "INSERT INTO tenant (id, name) VALUES ($1, 'Alpha'), ($2, 'Beta')",
      [first, second],
    );
  } finally {
    await client.end();
  }
}
