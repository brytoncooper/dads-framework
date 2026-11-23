import type { StarterProjectFile } from "./render-starter-project.js";

/** Minimal documentation and starter test suite without example domains. */
export function renderMinimalDocsAndTestFiles(): readonly StarterProjectFile[] {
  return [minimalReadmeFile(), minimalDeployFile(), sessionSubjectsTestFile(), starterIntegrationTestFile()];
}

function minimalReadmeFile(): StarterProjectFile {
  return {
    path: "README.md",
    content: `# Dads app

This project runs a React browser shell, named customer and staff Fastify APIs,
Better Auth identity, multi-tenant workspaces, and PostgreSQL migrations.

## Start

With Node 24, npm, and Docker running, execute \`npm start\` from the generated
project. Open the browser URL printed by the command. Use \`npm run dev:status\`
to look up the URL and \`npm run dev:down\` to stop the stack. See
[local development](./assembly/LOCAL-DEV.md) for ports, logs, and restart commands.

In the browser, select **Create an account**. Run \`npm run dev:mail\` in a second
terminal and open the verification link, then sign in and create a workspace.

## Add your first domain

Generate a relationship-guarded resource and mount it on the customer API:

\`\`\`sh
npx dad add resource products --api customer
\`\`\`

Keep contracts, access rules, and storage inside \`domains/<name>/\`. Register
each domain plugin explicitly in \`apps/<api>/app.ts\` and register migration
sources in \`assembly/migrations.ts\`.

## Test and verify

From the generated project, run the integration test with Docker running:

\`\`\`sh
npm test -- tests/starter.integration.test.ts
\`\`\`

Run \`npm run verify\` to check domain boundaries, TypeScript types, the web
build, and the test suite.

## Deploy

Follow [run outside development](./DEPLOY.md) for migrations, runtime settings,
and smoke checks. Set \`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT\` to export traces.
`,
  };
}

function minimalDeployFile(): StarterProjectFile {
  return {
    path: "DEPLOY.md",
    content: `# Run outside development

For local development, use \`npm start\` to run the Compose stack and print its
assigned URLs. The [app README](./README.md#start) covers that workflow.

The API needs Node 24, a reachable PostgreSQL database, and a process supervisor
that sends a termination signal on shutdown.

## Prepare the release

1. Install from the committed lockfile with \`npm ci\` and run \`npm run verify\`.
2. Run \`npm run build:web\`. Serve the entire \`dist/\` directory, configure a
   fallback to \`index.html\` for browser routes, and forward same-origin \`/api\`
   requests to the customer API.
3. Configure \`DATABASE_URL\` and \`DADS_IDENTITY_SECRET\` in the runtime secret
   store. Set \`DADS_BASE_URL\` to the public HTTPS origin for sign-in.
4. Connect email delivery to a real provider and configure durable file storage
   for features that write files.
5. Run \`npm run migrate\` once against the target database before starting the
   new API processes.

## Start and check

Set \`NODE_ENV=production\` and run \`npm run start:api\`. Select \`DADS_API=customer\`
for the customer routes or \`DADS_API=staff\` for the staff routes. Set \`PORT\` for
each process and \`HOST\` to the interface reached by your ingress.

\`\`\`sh
NODE_ENV=production DADS_API=customer HOST=127.0.0.1 PORT=3000 npm run start:api
\`\`\`

Check liveness from a second terminal:

\`\`\`sh
curl -fsS http://127.0.0.1:3000/api/health
\`\`\`

A healthy API returns HTTP 200 with \`{ "data": { "status": "ok" } }\`.
`,
  };
}

function sessionSubjectsTestFile(): StarterProjectFile {
  return {
    path: "tests/session-subjects.test.ts",
    content: `import type { IdentitySession } from "@dads-framework/identity";
import { expect, it, vi } from "vitest";

import { sessionSubjects } from "../assembly/session-subjects.js";

it("resolves valid sessions and rejects malformed tenant parameters", async () => {
  const tenantId = "c56a4180-65aa-4a42-80d3-f8e3159b9966";
  const session: IdentitySession = {
    account: {
      id: "user-1",
      email: "member@example.test",
      emailVerified: true,
    },
    expiresAt: new Date(),
  };
  const readSession = vi.fn(() => Promise.resolve(session));
  const identity = {
    handle: () => Promise.resolve(new Response(null)),
    readSession,
  };
  const subjects = sessionSubjects(identity);
  const headers = { cookie: "fixture" };

  expect(
    await subjects.resolve({ headers, params: { tenantId: "invalid" } }),
  ).toBeNull();
  expect(readSession).not.toHaveBeenCalled();

  expect(
    await subjects.resolve({ headers, params: { tenantId } }),
  ).toMatchObject({ id: session.account.id });
  expect(await subjects.resolve({ headers, url: "/api/tenants" })).toMatchObject(
    { id: session.account.id },
  );
});
`,
  };
}

function starterIntegrationTestFile(): StarterProjectFile {
  return {
    path: "tests/starter.integration.test.ts",
    content: `import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import { z } from "zod";

import { migrate } from "../assembly/migrations.js";
import { startApp } from "../assembly/start-app.js";
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
  "migrates Postgres, serves health, isolates tenants, and denies cross-tenant writes",
  { timeout: 90_000 },
  async () => {
    const postgres = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    const state = await mkdtemp(join(tmpdir(), "dads-minimal-services-"));
    try {
      const databaseUrl = postgres.getConnectionUri();
      await migrate(databaseUrl);
      await migrate(databaseUrl);
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
      const customer = await startApp("customer", config);
      const staff = await startApp("staff", config);
      try {
        expect(
          (await customer.inject({ method: "GET", url: "/api/health" }))
            .statusCode,
        ).toBe(200);
        expect(
          (await staff.inject({ method: "GET", url: "/api/health" }))
            .statusCode,
        ).toBe(200);

        const alpha = await createAccount(
          customer,
          emails,
          "alpha@example.test",
        );
        const beta = await createAccount(customer, emails, "beta@example.test");
        const alphaTenant = await createTenant(customer, alpha, "Alpha");
        await createTenant(customer, beta, "Beta");

        const alphaList = await customer.inject({
          method: "GET",
          url: "/api/tenants",
          headers: requestHeaders(alpha),
        });
        expect(alphaList.statusCode).toBe(200);
        expect(alphaList.body).toContain("Alpha");
        expect(alphaList.body).not.toContain("Beta");

        expect(
          (
            await customer.inject({
              method: "POST",
              url: \`/api/tenants/\${alphaTenant}/invitations\`,
              headers: requestHeaders(beta),
              payload: { email: "outsider@example.test" },
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await customer.inject({
              method: "POST",
              url: \`/api/tenants/\${alphaTenant}/invitations\`,
              headers: requestHeaders(),
              payload: { email: "outsider@example.test" },
            })
          ).statusCode,
        ).toBe(401);
      } finally {
        await Promise.all([customer.close(), staff.close()]);
      }
    } finally {
      await rm(state, { recursive: true, force: true });
      await postgres.stop();
    }
  },
);
`,
  };
}
