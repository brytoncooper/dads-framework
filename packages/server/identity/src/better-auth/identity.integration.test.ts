import { verifyIdentitySessionConformance } from "../testing/index.js";
import type { Identity, IdentityEmail } from "../index.js";
import { createBetterAuthIdentity, installIdentitySchemaV2 } from "./index.js";
import {
  startUnmigratedTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";
import { Buffer } from "node:buffer";
import { MigrationBuilder } from "node-pg-migrate";
import { afterAll, beforeAll, expect, it } from "vitest";

const ORIGIN = "https://identity.example.test";
const PASS = "a-long-test-password";
const NEW_PASS = "updated-long-test-password";
const mail: IdentityEmail[] = [];
let nextClient = 10;
let database: TestPostgres | undefined;
let identity: Identity;

beforeAll(async () => {
  const postgres = await startUnmigratedTestPostgres({ attributed: false });
  database = postgres;
  const migration = new MigrationBuilder(
    {
      query: () => Promise.reject(new Error("Schema assembly performs no I/O")),
      select: () => Promise.resolve([]),
    },
    undefined,
    false,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );
  installIdentitySchemaV2(migration);
  await postgres.pool.query(migration.getSql());
  identity = createBetterAuthIdentity({
    database: postgres,
    baseUrl: ORIGIN,
    secret: "nonsecret-test-fixture-value-identity-321-456",
    canInvite: (account) =>
      Promise.resolve(account.email === "issuer@example.test"),
    enqueueEmail: (message) => {
      mail.push(message);
      return Promise.resolve();
    },
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

function auth(
  path: string,
  body?: object,
  cookie?: string,
  origin = ORIGIN,
): Promise<Response> {
  const headers = new Headers({
    origin,
    "x-forwarded-for": `198.51.100.${String(nextClient++)}`,
  });
  if (cookie !== undefined) headers.set("cookie", cookie);
  if (body === undefined)
    return identity.handle(
      new Request(ORIGIN + "/api/auth" + path, { headers }),
    );
  headers.set("content-type", "application/json");
  return identity.handle(
    new Request(ORIGIN + "/api/auth" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function messageTo(email: string, kind: IdentityEmail["kind"]): IdentityEmail {
  const entry = mail.findLast(
    (message) => message.to === email && message.kind === kind,
  );
  if (entry === undefined)
    throw new Error("Expected an email in the recording adapter.");
  return entry;
}

async function signUp(email: string): Promise<Response> {
  return auth("/sign-up/email", {
    name: "Example account",
    email,
    password: PASS,
  });
}

async function activate(email: string): Promise<void> {
  const response = await identity.handle(
    new Request(messageTo(email, "verify-email").url, {
      headers: { "x-forwarded-for": `198.51.100.${String(nextClient++)}` },
    }),
  );
  expect(response.status).toBe(302);
}

async function signIn(email: string, password = PASS): Promise<string> {
  const response = await auth("/sign-in/email", { email, password });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.includes("session_token"));
  expect(session).toContain("Secure");
  expect(session).toContain("HttpOnly");
  expect(session).not.toContain("Domain=");
  expect(await response.json()).toEqual({ ok: true });
  const cookie = session?.split(";")[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  return cookie;
}

async function createAccount(email: string): Promise<string> {
  expect((await signUp(email)).status).toBe(200);
  await activate(email);
  return signIn(email);
}

async function resetTokenFor(email: string): Promise<string> {
  const linked = await identity.handle(
    new Request(messageTo(email, "reset-password").url),
  );
  const location = linked.headers.get("location");
  if (location === null) throw new Error("Expected the reset page redirect.");
  const token = new URL(location, ORIGIN).searchParams.get("token");
  if (token === null) throw new Error("Expected a password reset token.");
  return token;
}

it("keeps registration non-enumerating, proves mailbox ownership, and revokes sessions", async () => {
  const email = "session@example.test";
  const first = await signUp(email);
  const duplicate = await signUp(email);
  expect(first.status).toBe(200);
  expect(duplicate.status).toBe(first.status);
  expect(await duplicate.json()).toEqual(await first.json());
  expect(duplicate.headers.getSetCookie()).toEqual([]);
  expect((await auth("/sign-in/email", { email, password: PASS })).status).toBe(
    403,
  );
  await activate(email);
  const cookie = await signIn(email);
  const headers = new Headers({ cookie });
  const session = await identity.readSession(headers);
  expect(session?.account.email).toBe(email);
  expect(session?.account.emailVerified).toBe(true);
  expect(session?.expiresAt).toBeInstanceOf(Date);
  const sessionBody: unknown = await (
    await auth("/get-session", undefined, cookie)
  ).json();
  expect(sessionBody).toEqual({
    account: session?.account,
    expiresAt: session?.expiresAt.toISOString(),
  });
  const token = await auth("/token", undefined, cookie);
  expect(token.status).toBe(200);
  const tokenBody: unknown = await token.json();
  if (
    typeof tokenBody !== "object" ||
    tokenBody === null ||
    !("token" in tokenBody) ||
    typeof tokenBody.token !== "string"
  ) {
    throw new Error("Expected a signed token.");
  }
  const payload = tokenBody.token.split(".")[1];
  if (payload === undefined) throw new Error("Expected a token claim set.");
  const claims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  if (typeof claims !== "object" || claims === null) {
    throw new Error("Expected token claims.");
  }
  expect(Object.keys(claims).sort()).toEqual([
    "aud",
    "exp",
    "iat",
    "iss",
    "sid",
    "sub",
  ]);
  expect("sub" in claims && claims.sub).toBe(session?.account.id);
  expect("aud" in claims && claims.aud).toBe(ORIGIN);
  expect("iss" in claims && claims.iss).toBe(ORIGIN);
  expect("sid" in claims && typeof claims.sid).toBe("string");
  if (
    !("exp" in claims) ||
    !("iat" in claims) ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number"
  ) {
    throw new Error("Expected expiration and issued-at timestamps.");
  }
  expect(claims.exp - claims.iat).toBe(300);
  expect((await auth("/jwks")).status).toBe(200);
  expect((await auth("/sign-out", {}, cookie)).status).toBe(200);
  expect(await identity.readSession(headers)).toBeNull();
  expect((await auth("/token", undefined, cookie)).status).toBe(401);
  expect((await auth("/list-sessions", undefined, cookie)).status).toBe(404);

  const later = await signIn(email);
  if (database === undefined) throw new Error("Expected a database.");
  await database.pool.query(
    "UPDATE identity_sessions SET \"expiresAt\" = now() - interval '1 second'",
  );
  expect(await identity.readSession(new Headers({ cookie: later }))).toBeNull();
});

it("acknowledges unknown reset addresses identically and spends a reset once", async () => {
  const email = "reset@example.test";
  const previous = await createAccount(email);
  const second = await signIn(email);
  const redirectTo = ORIGIN + "/reset-password";
  const reset = await auth("/request-password-reset", { email, redirectTo });
  const unknown = await auth("/request-password-reset", {
    email: "unknown@example.test",
    redirectTo,
  });
  expect(reset.status).toBe(200);
  expect(unknown.status).toBe(reset.status);
  expect(await unknown.json()).toEqual(await reset.json());
  expect(mail.some((message) => message.to === "unknown@example.test")).toBe(
    false,
  );

  const token = await resetTokenFor(email);
  if (database === undefined) throw new Error("Expected a database.");
  const plaintext = await database.pool.query(
    "SELECT 1 FROM identity_credentials WHERE password = $1",
    [PASS],
  );
  const storedToken = await database.pool.query(
    "SELECT 1 FROM identity_verifications WHERE identifier = $1",
    [`reset-password:${token}`],
  );
  expect(plaintext.rowCount).toBe(0);
  expect(storedToken.rowCount).toBe(0);
  const attempts = await Promise.all([
    auth("/reset-password", { token, newPassword: NEW_PASS }),
    auth("/reset-password", { token, newPassword: NEW_PASS }),
  ]);
  expect(attempts.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  expect(
    await identity.readSession(new Headers({ cookie: previous })),
  ).toBeNull();
  expect(
    await identity.readSession(new Headers({ cookie: second })),
  ).toBeNull();
  expect((await auth("/sign-in/email", { email, password: PASS })).status).toBe(
    401,
  );
  await signIn(email, NEW_PASS);

  expect(
    (await auth("/request-password-reset", { email, redirectTo })).status,
  ).toBe(200);
  const expired = await resetTokenFor(email);
  await database.pool.query(
    `UPDATE identity_verifications SET "expiresAt" = now() - interval '1 second'`,
  );
  expect(
    (await auth("/reset-password", { token: expired, newPassword: PASS }))
      .status,
  ).toBe(400);
});

it("allows only authorized issuers and verified matching recipients to use an invite", async () => {
  const issuer = await createAccount("issuer@example.test");
  const email = "recipient@example.test";
  const recipient = await createAccount(email);
  const stranger = await createAccount("stranger@example.test");
  expect((await auth("/invite", { email })).status).toBe(401);
  expect((await auth("/invite", { email }, stranger)).status).toBe(403);
  expect(
    (await auth("/invite", { email }, issuer, "https://outside.example.test"))
      .status,
  ).toBe(403);
  const issued = await auth(
    "/invite",
    { email: "RECIPIENT@example.test" },
    issuer,
  );
  expect(issued.status).toBe(202);
  expect(await issued.json()).toEqual({ ok: true });
  const link = new URL(messageTo(email, "account-invitation").url);
  expect(link.search).toBe("");
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  expect(token).toEqual(expect.any(String));

  expect((await auth("/accept-invitation", { token })).status).toBe(401);
  expect((await auth("/accept-invitation", { token }, stranger)).status).toBe(
    400,
  );
  const race = await Promise.all([
    auth("/accept-invitation", { token }, recipient),
    auth("/accept-invitation", { token }, recipient),
  ]);
  expect(race.map((response) => response.status).sort()).toEqual([200, 400]);

  expect((await auth("/invite", { email }, issuer)).status).toBe(202);
  const next = new URL(messageTo(email, "account-invitation").url);
  const expired = new URLSearchParams(next.hash.slice(1)).get("token");
  if (database === undefined) throw new Error("Expected a database.");
  await database.pool.query(
    "UPDATE identity_account_invitations SET expires_at = now() - interval '1 second' WHERE email = $1",
    [email],
  );
  expect(
    (await auth("/accept-invitation", { token: expired }, recipient)).status,
  ).toBe(400);
});

it("runs the shared session conformance against Postgres", async () => {
  const email = "conformance@example.test";
  const activeCookie = await createAccount(email);
  const otherCookie = await signIn(email);
  const expiredCookie = await signIn(email);
  const original = await identity.readSession(
    new Headers({ cookie: activeCookie }),
  );
  if (original === null || database === undefined)
    throw new Error("Expected an active session.");
  await database.pool.query(
    'UPDATE identity_sessions SET "expiresAt" = now() - interval \'1 second\' WHERE id = (SELECT id FROM identity_sessions WHERE "userId" = $1 ORDER BY "createdAt" DESC, id LIMIT 1)',
    [original.account.id],
  );
  await verifyIdentitySessionConformance({
    identity,
    origin: ORIGIN,
    activeCookie,
    otherCookie,
    expiredCookie,
    account: original.account,
  });
});
