import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { runNodePgMigrations } from "@dads-framework/postgres/migrations";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it, vi } from "vitest";
import {
  createBetterAuthIdentity,
  createEnterpriseBetterAuthIdentity,
  enterpriseSsoDomainChallenge,
  type EnterpriseSsoProvider,
} from "./index.js";

vi.mock("node:dns/promises", () => ({ resolveTxt: vi.fn() }));

it("authenticates a verified OIDC identity and enforces tenant scope, required mode, browser state and subject binding", async () => {
  const database = await startUnmigratedTestPostgres({ attributed: false });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const keys = [{ ...publicKey.export({ format: "jwk" }), kid: "test-key" }];
  let origin = "";
  let email = "oidc-user@example.test";
  let subject = "subject-one";
  let challenge = "";
  let verified = true;
  let validSignature = true;
  const idp = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/keys") {
      response.end(JSON.stringify({ keys }));
      return;
    }
    if (request.url !== "/token") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const verifier = body.get("code_verifier");
      if (verifier === null || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
        response.writeHead(400).end("{}");
        return;
      }
      const protectedHeader = encode({ alg: "RS256", kid: "test-key" });
      const claims = encode({
        iss: origin,
        aud: "fixture",
        sub: subject,
        email,
        email_verified: verified,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 90,
      });
      const content = `${protectedHeader}.${claims}`;
      const signature = validSignature
        ? sign("sha256", Buffer.from(content), privateKey).toString("base64url")
        : "invalid";
      response.end(
        JSON.stringify({
          id_token: `${content}.${signature}`,
          access_token: "fixture-token",
          token_type: "Bearer",
        }),
      );
    });
  });

  try {
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    const bound = idp.address();
    if (typeof bound !== "object" || bound === null) throw new Error("Expected a listening IdP.");
    origin = `http://127.0.0.1:${bound.port}`;
    await runNodePgMigrations({
      databaseUrl: database.connectionString,
      workspace: {
        root: fileURLToPath(new URL("../..", import.meta.url)),
        sources: [
          {
            root: "src/better-auth/lib/migrations",
            files: /^src\/better-auth\/lib\/migrations\/[^/]+\.migration\.ts$/u,
            required: true,
            owner: "identity-better-auth",
          },
        ],
        moduleAliases: {},
      },
    });
    const secret = randomBytes(32).toString("hex");
    const proof = enterpriseSsoDomainChallenge(secret, "tenant-one", "example.test");
    vi.mocked(resolveTxt).mockImplementation((name) => Promise.resolve(name === proof.name ? [[proof.value]] : []));
    const provider = {
      id: "sso-tenant-one",
      tenantId: "tenant-one",
      domain: "example.test",
      mode: "required",
      protocol: "oidc",
      issuer: origin,
      clientId: "fixture",
      clientSecret: "fixture-secret",
      authorizationEndpoint: origin + "/authorize",
      tokenEndpoint: origin + "/token",
      jwksEndpoint: origin + "/keys",
    } satisfies EnterpriseSsoProvider;
    let verificationLink = "";
    const options = {
      database,
      baseUrl: origin,
      secret,
      canInvite: () => Promise.resolve(false),
      enqueueEmail: ({ url }: { url: string }) => {
        verificationLink = url;
        return Promise.resolve();
      },
    };
    const passwordOnly = createBetterAuthIdentity(options);
    const password = {
      email,
      name: "Local account",
      password: "a-long-example-password",
    };
    expect((await passwordOnly.handle(authRequest(origin, "/sign-up/email", password))).status).toBe(200);
    expect((await passwordOnly.handle(new Request(verificationLink))).status).toBe(302);
    const passwordCookie = browserCookies(await passwordOnly.handle(authRequest(origin, "/sign-in/email", password)));
    expect(passwordCookie).toContain("session_token");

    await expect(
      createEnterpriseBetterAuthIdentity(options, [{ ...provider, tenantId: "tenant-two" }]),
    ).rejects.toThrow("Enterprise SSO domain verification failed");
    const identity = await createEnterpriseBetterAuthIdentity(options, [provider]);
    const read = (cookie: string) => new Headers({ cookie });
    expect(await identity.readSession(read(passwordCookie))).toBeNull();
    expect(
      (
        await identity.handle(
          new Request(origin + "/api/auth/token", {
            headers: read(passwordCookie),
          }),
        )
      ).status,
    ).toBe(401);
    expect((await identity.handle(authRequest(origin, "/sign-in/email", password))).ok).toBe(false);
    expect((await identity.handle(authRequest(origin, "/sso/register", {}))).status).toBe(404);
    expect(
      (
        await identity.handle(
          authRequest(origin, "/sign-in/sso", {
            providerId: provider.id,
            callbackURL: "https://wrong.test/",
          }),
        )
      ).status,
    ).toBe(400);

    let address = 70;
    async function begin() {
      const start = authRequest(origin, "/sign-in/sso", {
        providerId: provider.id,
        callbackURL: "/welcome",
      });
      start.headers.set("x-forwarded-for", `192.0.2.${String(address++)}`);
      const response = await identity.handle(start);
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("url" in payload) || typeof payload.url !== "string")
        throw new Error("Expected OIDC authorization URL.");
      const authorize = new URL(payload.url);
      challenge = authorize.searchParams.get("code_challenge") ?? "";
      expect(challenge).not.toBe("");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      const cookie = browserCookies(response);
      return { callback, cookie };
    }

    async function finish() {
      const { callback, cookie } = await begin();
      return identity.handle(new Request(callback, { headers: read(cookie) }));
    }

    const attempt = await begin();
    expect((await identity.handle(new Request(attempt.callback))).status).toBe(403);
    const success = await identity.handle(new Request(attempt.callback, { headers: read(attempt.cookie) }));
    expect(success.status, await success.clone().text()).toBe(302);
    expect(success.headers.get("location")).toBe(origin + "/welcome");
    const enterpriseCookie = browserCookies(success);
    const session = await identity.readEnterpriseSession(read(enterpriseCookie), "tenant-one", 60_000);
    expect(session?.account.email).toBe(email);
    expect(session?.providerId).toBe(provider.id);
    expect(await identity.readEnterpriseSession(read(enterpriseCookie), "tenant-two")).toBeNull();
    expect(await identity.readEnterpriseSession(read(enterpriseCookie), "tenant-one", -1)).toBeNull();
    expect((await identity.readTenantSession(read(enterpriseCookie), "tenant-one"))?.account.id).toBe(
      session?.account.id,
    );
    expect(
      browserCookies(await identity.handle(new Request(attempt.callback, { headers: read(attempt.cookie) }))),
    ).not.toContain("session_token");

    subject = "subject-two";
    expect(browserCookies(await finish())).not.toContain("session_token");
    subject = "subject-one";
    verified = false;
    expect(browserCookies(await finish())).not.toContain("session_token");
    verified = true;
    validSignature = false;
    expect(browserCookies(await finish())).not.toContain("session_token");
    validSignature = true;
    email = "oidc-user@outside.test";
    expect(browserCookies(await finish())).not.toContain("session_token");
    subject = "subject-three";
    email = "new-oidc-user@example.test";
    const enrolled = await finish();
    expect(enrolled.headers.get("location")).toBe(origin + "/welcome");
    const newSession = await identity.readEnterpriseSession(read(browserCookies(enrolled)), provider.tenantId);
    expect(newSession?.account).toMatchObject({ email, emailVerified: true });
    const persistedTokens = await database.pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM identity_credentials WHERE "idToken" IS NOT NULL OR "accessToken" IS NOT NULL',
    );
    expect(persistedTokens.rows[0]?.count).toBe(0);
  } finally {
    idp.close();
    await database.stop();
  }
}, 120_000);

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function authRequest(origin: string, path: string, body: object): Request {
  return new Request(origin + "/api/auth" + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function browserCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
