import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enterpriseSsoDomainChallenge } from "@dads-framework/identity/better-auth";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { connectPostgresClient } from "@dads-framework/postgres";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { migrate } from "../assembly/migrations.js";
import { startApp } from "../assembly/start-app.js";
import { proveAuditExport } from "./audit-export.test-support.js";
import { withDnsTxtRecord } from "./dns-txt.test-support.js";
import { proveNoteArtifacts } from "./note-artifacts.test-support.js";
import {
  provePermissionsAfterInvite,
  provePermissionsBeforeInvite,
} from "./permissions-dashboard.test-support.js";
import type { StarterEmail } from "../libraries/app-runtime/index.js";

const origin = "http://127.0.0.1:3000";
const secret = "fixture-signing-key-with-forty-characters";
const password = "starter-test-password-1";
const responseId = z.object({ data: z.object({ id: z.uuid() }) });
type Http = Awaited<ReturnType<typeof startApp>>;

function requestHeaders(cookie?: string) {
  return {
    origin,
    host: new URL(origin).host,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function createAccount(
  http: Http,
  emails: StarterEmail[],
  email: string,
) {
  const signUp = await http.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: requestHeaders(),
    payload: { email, password, name: email },
  });
  expect(signUp.statusCode).toBe(200);
  const mail = emails.find(
    (message) => message.to === email && message.kind === "verify-email",
  );
  if (mail === undefined)
    throw new Error("Verification email was not enqueued.");
  const link = new URL(mail.url);
  const verified = await http.inject({
    method: "GET",
    url: link.pathname + link.search,
    headers: requestHeaders(),
  });
  expect([200, 302]).toContain(verified.statusCode);
  const session = await http.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: requestHeaders(),
    payload: { email, password },
  });
  expect(session.statusCode).toBe(200);
  const header = session.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const cookie = cookies
    .map((value) => value?.split(";")[0])
    .filter(Boolean)
    .join("; ");
  expect(cookie.length).toBeGreaterThan(0);
  return cookie;
}

async function createTenant(http: Http, cookie: string, name: string) {
  const response = await http.inject({
    method: "POST",
    url: "/api/tenants",
    headers: requestHeaders(cookie),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  const parsed: unknown = JSON.parse(response.body);
  return responseId.parse(parsed).data.id;
}

it(
  "migrates Postgres and isolates two signed-in tenants across named APIs",
  { timeout: 90_000 },
  async () => {
    const postgres = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    const state = await mkdtemp(join(tmpdir(), "dads-starter-services-"));
    try {
      const databaseUrl = postgres.getConnectionUri();
      await migrate(databaseUrl);
      await migrate(databaseUrl);
      await proveLocalMail(databaseUrl, join(state, "mail"));
      const emails: StarterEmail[] = [];
      const config = {
        databaseUrl,
        baseUrl: origin,
        fileStorageDirectory: join(state, "files"),
        secret,
        enqueueEmail: (message: StarterEmail) => {
          emails.push(message);
          return Promise.resolve();
        },
      };
      const customer = await startApp("customer", {
        ...config,
        preparePermissionChecks: true,
      });
      const staff = await startApp("staff", config);
      try {
        const alpha = await createAccount(
          customer,
          emails,
          "alpha@example.test",
        );
        const beta = await createAccount(customer, emails, "beta@example.test");
        const alphaTenant = await createTenant(customer, alpha, "Alpha");
        const betaTenant = await createTenant(customer, beta, "Beta");
        const alphaNotes = `/api/tenants/${alphaTenant}/notes`;
        const betaNotes = `/api/tenants/${betaTenant}/notes`;

        const created = await customer.inject({
          method: "POST",
          url: alphaNotes,
          headers: requestHeaders(alpha),
          payload: { text: "Alpha's note" },
        });
        expect(created.statusCode).toBe(201);
        const noteId = responseId.parse(created.json()).data.id;
        await proveNoteArtifacts(
          customer,
          `${alphaNotes}/${noteId}`,
          requestHeaders(alpha),
          requestHeaders(beta),
        );
        const alphaRead = await customer.inject({
          method: "GET",
          url: alphaNotes,
          headers: requestHeaders(alpha),
        });
        expect(alphaRead.statusCode).toBe(200);
        expect(alphaRead.body).toContain("Alpha's note");
        const betaRead = await customer.inject({
          method: "GET",
          url: betaNotes,
          headers: requestHeaders(beta),
        });
        expect(betaRead.statusCode).toBe(200);
        expect(betaRead.body).not.toContain("Alpha's note");
        expect(
          (
            await customer.inject({
              method: "GET",
              url: alphaNotes,
              headers: requestHeaders(beta),
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (await customer.inject({ method: "GET", url: alphaNotes }))
            .statusCode,
        ).toBe(401);
        expect(
          (
            await staff.inject({
              method: "GET",
              url: alphaNotes,
              headers: requestHeaders(alpha),
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await customer.inject({
              method: "GET",
              url: alphaNotes + "/features",
              headers: requestHeaders(alpha),
            })
          ).statusCode,
        ).toBe(200);
        const betaAccount = await provePermissionsBeforeInvite(
          customer,
          betaTenant,
          beta,
          alpha,
          requestHeaders,
        );
        await provePermissionsBeforeInvite(
          customer,
          alphaTenant,
          alpha,
          beta,
          requestHeaders,
        );
        const crossTenantAccount = await customer.inject({
          method: "GET",
          url: `/api/tenants/${alphaTenant}/members/${encodeURIComponent(betaAccount)}/permissions`,
          headers: requestHeaders(alpha),
        });
        expect(crossTenantAccount.statusCode).toBe(404);
        await proveInvitation({
          customer,
          emails,
          issuerCookie: alpha,
          recipientCookie: beta,
          tenantId: alphaTenant,
          databaseUrl,
          config,
        });
        await provePermissionsAfterInvite(
          customer,
          alphaTenant,
          alpha,
          beta,
          requestHeaders,
        );
        await proveAuditExport({
          customer,
          staff,
          owner: requestHeaders(alpha),
          member: requestHeaders(beta),
          tenantId: alphaTenant,
          otherTenantId: betaTenant,
        });
      } finally {
        await Promise.all([customer.close(), staff.close()]);
      }
    } finally {
      await postgres.stop();
      await rm(state, { recursive: true, force: true });
    }
  },
);

type InvitationProof = {
  readonly customer: Http;
  readonly emails: StarterEmail[];
  readonly issuerCookie: string;
  readonly recipientCookie: string;
  readonly tenantId: string;
  readonly databaseUrl: string;
  readonly config: Parameters<typeof startApp>[1];
};

async function proveInvitation(proof: InvitationProof) {
  const { customer, issuerCookie, recipientCookie, tenantId, databaseUrl } =
    proof;
  const target = "beta@example.test";
  const issue = `/api/tenants/${tenantId}/invitations`;
  const denied = await customer.inject({
    method: "POST",
    url: issue,
    headers: requestHeaders(recipientCookie),
    payload: { email: target },
  });
  expect(denied.statusCode).toBe(404);

  const token = await invite(proof, target);
  expect((await accept(customer, token)).statusCode).toBe(401);
  expect((await accept(customer, token, issuerCookie)).statusCode).toBe(404);
  const wrongOrigin = await customer.inject({
    method: "POST",
    url: "/api/tenants/invitations/accept",
    headers: {
      ...requestHeaders(recipientCookie),
      origin: "https://other.example.test",
    },
    payload: { token },
  });
  expect(wrongOrigin.statusCode).toBe(403);

  await proveRequiredSsoInvitation(proof, token);

  const joined = await accept(customer, token, recipientCookie);
  expect(joined.statusCode).toBe(200);
  expect(joined.json()).toEqual({ data: { tenantId } });
  expect((await accept(customer, token, recipientCookie)).statusCode).toBe(404);

  const notes = await customer.inject({
    method: "GET",
    url: `/api/tenants/${tenantId}/notes`,
    headers: requestHeaders(recipientCookie),
  });
  expect(notes.statusCode).toBe(200);

  const expired = await invite(proof, target);
  const client = await connectPostgresClient(databaseUrl);
  try {
    await client.query(
      "UPDATE tenant_invitation SET expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND recipient_email = $2 AND accepted_at IS NULL",
      [tenantId, target],
    );
  } finally {
    await client.end();
  }
  expect((await accept(customer, expired, recipientCookie)).statusCode).toBe(
    404,
  );
}

async function proveRequiredSsoInvitation(
  { config, recipientCookie, issuerCookie, tenantId }: InvitationProof,
  token: string,
) {
  const domain = "company.example.test";
  const challenge = enterpriseSsoDomainChallenge(secret, tenantId, domain);
  const required = await withDnsTxtRecord(challenge, () =>
    startApp("customer", {
      ...config,
      enterprise: {
        ssoProviders: [
          {
            id: "sso-fixture",
            tenantId,
            domain,
            mode: "required",
            protocol: "oidc",
            issuer: origin,
            clientId: "fixture",
            clientSecret: "fixture-secret",
            authorizationEndpoint: `${origin}/authorize`,
            tokenEndpoint: `${origin}/token`,
            jwksEndpoint: `${origin}/keys`,
          },
        ],
      },
    }),
  );
  try {
    const owner = await required.inject({
      url: `/api/tenants/${tenantId}/notes`,
      headers: requestHeaders(issuerCookie),
    });
    expect(owner.statusCode).toBe(401);
    expect((await accept(required, token, recipientCookie)).statusCode).toBe(
      404,
    );
  } finally {
    await required.close();
  }
}

async function invite(
  { customer, emails, issuerCookie, tenantId }: InvitationProof,
  email: string,
) {
  const response = await customer.inject({
    method: "POST",
    url: `/api/tenants/${tenantId}/invitations`,
    headers: requestHeaders(issuerCookie),
    payload: { email },
  });
  expect(response.statusCode).toBe(201);
  const body: unknown = response.json();
  z.strictObject({
    data: z.strictObject({ expiresAt: z.iso.datetime() }),
  }).parse(body);
  const message = emails.findLast(
    (mail) => mail.kind === "tenant-invitation" && mail.to === email,
  );
  if (message === undefined)
    throw new Error("Expected a tenant invitation email.");
  const link = new URL(message.url);
  expect(link.search).toBe("");
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  if (token === null)
    throw new Error("Expected the token in the URL fragment.");
  return token;
}

function accept(customer: Http, token: string, cookie?: string) {
  return customer.inject({
    method: "POST",
    url: "/api/tenants/invitations/accept",
    headers: requestHeaders(cookie),
    payload: { token },
  });
}

async function proveLocalMail(
  databaseUrl: string,
  directory: string,
): Promise<void> {
  const app = await startApp("customer", {
    databaseUrl,
    baseUrl: origin,
    secret,
    mailSpoolDirectory: directory,
  });
  try {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: requestHeaders(),
      payload: {
        email: "local-mail@example.test",
        password,
        name: "Local mail",
      },
    });
    expect(signup.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const message = (await readdir(directory)).find((file) =>
        file.endsWith(".json"),
      );
      if (!message)
        throw new Error("Expected a verification message in the local spool.");
      const envelope = await readFile(join(directory, message), "utf8");
      expect(envelope).toContain("local-mail@example.test");
      expect(envelope).toContain("/api/auth/verify-email");
    });
  } finally {
    await app.close();
  }
}
