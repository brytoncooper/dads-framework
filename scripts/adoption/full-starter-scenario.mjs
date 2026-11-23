import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL, URLSearchParams } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";

const execute = promisify(execFile);
const password = "dads-proof-password-123";
const ownerEmail = "owner@example.test";
const guestEmail = "guest@example.test";

export async function proveStarterScenario(urls, apiContainer, project) {
  for (const origin of [urls.apiUrl, urls.staffUrl]) {
    assert.equal((await data(origin, "/api/health", 200)).status, "ok");
    assert.equal((await data(origin, "/api/ready", 200)).status, "ready");
  }
  const owner = await signIn(urls.webUrl, project, ownerEmail);
  const guest = await signIn(urls.webUrl, project, guestEmail);
  const tenant = await data(urls.webUrl, "/api/tenants", 201, {
    session: owner.cookie,
    body: { name: "Proof workspace" },
  });
  assert.match(tenant.id, /^[0-9a-f-]{36}$/);
  const path = "/api/tenants/" + tenant.id;
  const notesPath = path + "/notes";
  const text = "A disposable starter proof note";
  const note = await data(urls.webUrl, notesPath, 201, {
    session: owner.cookie,
    body: { text },
  });
  assert.match(note.id, /^[0-9a-f-]{36}$/);

  const readNotes = (session) => request(urls.webUrl, notesPath, { session });
  assert.equal((await readNotes()).status, 401);
  assert.equal((await readNotes(guest.cookie)).status, 404);
  await assertVisibleNote(await readNotes(owner.cookie), text);
  assert.equal(
    (
      await request(urls.staffUrl, notesPath, {
        session: owner.cookie,
        trustedOrigin: urls.webUrl,
      })
    ).status,
    404,
  );

  await data(urls.webUrl, path + "/invitations", 201, {
    session: owner.cookie,
    body: { email: guestEmail },
  });
  const invite = await readMailLink(
    project,
    guestEmail,
    "/accept-tenant-invitation",
  );
  const token = new URLSearchParams(invite.hash.slice(1)).get("token");
  assert.ok(token, "The development mailbox should contain the invitation");
  await data(urls.webUrl, "/api/tenants/invitations/accept", 200, {
    session: guest.cookie,
    body: { token },
  });
  await assertVisibleNote(await readNotes(guest.cookie), text);

  await proveOptionalCapabilities(
    urls.webUrl,
    notesPath + "/" + note.id,
    owner.cookie,
  );
  // The starter exposes invitations. This test administers the inverse via
  // the same tenant service to prove the normal read sees revocation.
  await revokeMembership(apiContainer, tenant.id, owner.id, guest.id);
  assert.equal((await readNotes(guest.cookie)).status, 404);
  await assertVisibleNote(await readNotes(owner.cookie), text);

  return async (webUrl) => {
    await assertVisibleNote(
      await request(webUrl, notesPath, { session: owner.cookie }),
      text,
    );
    assert.equal(
      (await request(webUrl, notesPath, { session: guest.cookie })).status,
      404,
    );
  };
}

function request(origin, path, { session, body, trustedOrigin = origin } = {}) {
  const headers = { origin: trustedOrigin };
  if (session !== undefined) headers.cookie = session;
  if (body !== undefined) headers["content-type"] = "application/json";
  return globalThis.fetch(new URL(path, origin), {
    headers,
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
}

async function data(origin, path, status, options) {
  const response = await request(origin, path, options);
  assert.equal(response.status, status, path);
  return (await response.json()).data;
}

async function signIn(origin, project, email) {
  const signUp = await request(origin, "/api/auth/sign-up/email", {
    body: { email, password, name: "Starter proof" },
  });
  assert.equal(signUp.status, 200);
  const verification = await readMailLink(
    project,
    email,
    "/api/auth/verify-email",
  );
  assert.equal(verification.origin, origin);
  const verified = await request(
    origin,
    verification.pathname + verification.search,
  );
  assert.ok([200, 302].includes(verified.status));
  const session = await request(origin, "/api/auth/sign-in/email", {
    body: { email, password },
  });
  assert.equal(session.status, 200);
  const cookie = session.headers
    .getSetCookie()
    .map((raw) => raw.split(";", 1)[0])
    .join("; ");
  assert.ok(cookie, "Signing in should create a session");
  const authenticated = await request(origin, "/api/auth/get-session", {
    session: cookie,
  });
  assert.equal(authenticated.status, 200);
  const { account } = await authenticated.json();
  assert.equal(account?.email, email);
  assert.equal(account?.emailVerified, true);
  assert.ok(account?.id, "The signed-in account should have an ID");
  return { cookie, id: account.id };
}

async function assertVisibleNote(response, text) {
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(text));
}

async function readMailLink(project, email, preferredPath) {
  return waitForResult(
    () => findMailLink(project, email, preferredPath),
    "Expected development mailbox link for " + preferredPath,
  );
}

async function findMailLink(project, email, preferredPath) {
  const { stdout } = await execute(
    "npm",
    ["run", "--silent", "dev:mail", "--", "--json"],
    { cwd: project },
  );
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true, "The development mailbox should be available");
  for (const message of receipt.mail) {
    if (!message.to.some(({ address }) => address === email)) continue;
    for (const candidate of message.text.matchAll(/https?:\/\/[^\s<>]+/g)) {
      const link = new URL(candidate[0]);
      if (link.pathname === preferredPath) return link;
    }
  }
  return undefined;
}

async function revokeMembership(container, tenantId, ownerId, guestId) {
  await execute("docker", [
    "exec",
    container,
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `import {compileAccess} from "@dads-framework/access";
     import {currentAuditActor, withSystemActor} from "@dads-framework/core/audit-actor";
     import {createPostgresConnection} from "@dads-framework/postgres";
     import {PostgresAuthorization, TransactionalAccessChanges} from "@dads-framework/postgres-access";
     import {Tenants} from "@dads-framework/identity/tenants";
     import {accountAccess, tenantAccess} from "./libraries/app-runtime/index.ts";
     const requestId = "starter-acceptance-revoke";
     const [tenantId, ownerId, guestId] = process.argv.slice(1);
     const connection = createPostgresConnection({
       schema: {}, connectionString: process.env.DATABASE_URL, auditActorSource: currentAuditActor
     }, {error: () => undefined});
     try {
       const authorization = new PostgresAuthorization({
         model: compileAccess([accountAccess, tenantAccess.tenant], {
           allowLookupResourcesOn: [tenantAccess.tenant],
         }),
         namespace: "starter",
         executor: connection.pool,
       });
       const tenants = new Tenants({
         database: connection.drizzle,
         access: tenantAccess,
         authorizationAt: (tx) => authorization.inDrizzleTransaction(tx),
         changes: new TransactionalAccessChanges(authorization, connection.drizzle),
       });
       await withSystemActor("starter-acceptance",
         () => tenants.memberships.removeMember(ownerId, tenantId, guestId), requestId);
       const recorded = await connection.pool.query(
         "SELECT actor_kind FROM audit_log WHERE request_id = $1 AND table_name = 'tenant_membership' AND operation = 'delete'",
         [requestId],
       );
       if (recorded.rowCount !== 1 || recorded.rows[0].actor_kind !== "system") throw new Error("Fixture revocation was not audited");
     } finally { await connection.close(); }`,
    tenantId,
    ownerId,
    guestId,
  ]);
}

async function proveOptionalCapabilities(origin, path, session) {
  const text = "Test-local attachment";
  const attachment = await data(origin, path + "/attachments", 201, {
    session,
    body: { text },
  });
  assert.ok(attachment.fileId);
  const fetched = await waitForResult(async () => {
    const result = await data(
      origin,
      path + "/attachments/" + attachment.fileId,
      200,
      { session },
    );
    return result.inspection === null ? undefined : result;
  }, "Expected the attachment inspection job to finish");
  assert.equal(fetched.text, text);
  assert.equal(fetched.inspection.bytes, Buffer.byteLength(text));
  assert.match(fetched.inspection.sha256, /^[a-f0-9]{64}$/);
  const csv = await data(origin, path + "/exports/csv", 200, { session });
  assert.match(csv.contentType, /^text\/csv/);
  assert.ok(
    Buffer.from(csv.base64, "base64")
      .toString("utf8")
      .includes("disposable starter proof note"),
  );
  const pdf = await data(origin, path + "/exports/pdf", 200, { session });
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(
    Buffer.from(pdf.base64, "base64").subarray(0, 5).toString(),
    "%PDF-",
  );
}

async function waitForResult(read, failure) {
  const deadline = globalThis.performance.now() + 20_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await setTimeout(250);
  } while (globalThis.performance.now() < deadline);
  throw new Error(failure);
}
