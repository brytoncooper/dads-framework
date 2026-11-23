import { normalizeIdentityEmail, type Identity, type IdentitySession } from "../../index.js";
import type { createAccountInvitations } from "./account-invitations.js";
import type { configureBetterAuth } from "./configure-better-auth.js";
import { IDENTITY_PATH } from "./identity-options.js";

const VENDOR_POST = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-out",
  "/request-password-reset",
  "/reset-password",
]);
const VENDOR_GET = new Set(["/verify-email", "/jwks", "/token"]);

type BetterAuth = ReturnType<typeof configureBetterAuth>;
type EnterpriseRoutes = (request: Request, route: string) => Promise<Response | undefined>;
type AccountInvitations = ReturnType<typeof createAccountInvitations>;

export function createIdentityHandler(
  vendor: BetterAuth,
  invitations: AccountInvitations,
  origin: string,
  readSession: Identity["readSession"],
  enterpriseRoutes?: EnterpriseRoutes,
): Identity["handle"] {
  return async (request) => {
    const path = routeOf(request);
    if (path === "GET /get-session") return sessionResponse(readSession, request.headers);
    if (path === "POST /invite" || path === "POST /accept-invitation") {
      return invitationResponse(request, path, origin, invitations, readSession);
    }
    if (path === null) return json({ error: "not-found" }, 404);
    if (enterpriseRoutes !== undefined) {
      const enterprise = await enterpriseResponse(request, path, enterpriseRoutes, readSession);
      if (enterprise !== undefined) return enterprise;
    }
    if (!isVendorPath(request.method, path)) {
      return json({ error: "not-found" }, 404);
    }
    return vendorResponse(await vendor.handler(request), path);
  };
}

async function sessionResponse(readSession: Identity["readSession"], headers: Headers): Promise<Response> {
  const session = await readSession(headers);
  return json(session === null ? null : { account: session.account, expiresAt: session.expiresAt }, 200);
}

async function enterpriseResponse(
  request: Request,
  path: string,
  routes: EnterpriseRoutes,
  readSession: Identity["readSession"],
): Promise<Response | undefined> {
  const enterprise = await routes(request, path);
  if (enterprise !== undefined) return vendorResponse(enterprise, path);
  if (path === "GET /token" && (await readSession(request.headers)) === null)
    return json({ error: "unauthorized" }, 401);
  return undefined;
}

function routeOf(request: Request): string | null {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${IDENTITY_PATH}/`)) return null;
  return `${request.method} ${path.slice(IDENTITY_PATH.length)}`;
}

function isVendorPath(method: string, path: string): boolean {
  const suffix = path.slice(method.length + 1);
  if (method === "POST") return VENDOR_POST.has(suffix);
  if (method !== "GET") return false;
  return VENDOR_GET.has(suffix) || /^\/reset-password\/[A-Za-z0-9_-]+$/u.test(suffix);
}

function vendorResponse(response: Response, path: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  const isPasswordSession = path === "POST /sign-in/email" || path === "POST /sign-up/email";
  if (response.ok && isPasswordSession) {
    headers.delete("content-length");
    return Response.json({ ok: true }, { headers, status: response.status });
  }
  return new Response(response.body, { headers, status: response.status });
}

async function invitationResponse(
  request: Request,
  path: string,
  origin: string,
  invitations: AccountInvitations,
  readSession: Identity["readSession"],
): Promise<Response> {
  if (request.headers.get("origin") !== origin) return json({ error: "forbidden" }, 403);
  const session = await readSession(request.headers);
  if (session === null) return json({ error: "unauthorized" }, 401);
  const parsed: unknown = await request.json().catch(() => null);
  if (typeof parsed !== "object" || parsed === null) return json({ error: "invalid-input" }, 400);
  if (path === "POST /invite") return issueInvitation(invitations, session, parsed);
  const accepted = await invitations.accept(session, "token" in parsed ? parsed.token : null);
  return accepted ? json({ ok: true }, 200) : json({ error: "invitation-invalid" }, 400);
}

async function issueInvitation(
  invitations: AccountInvitations,
  session: IdentitySession,
  input: object,
): Promise<Response> {
  const email = normalizeIdentityEmail("email" in input ? input.email : null);
  if (email === null) return json({ error: "invalid-input" }, 400);
  if (!(await invitations.issue(session, email))) {
    return json({ error: "forbidden" }, 403);
  }
  return json({ ok: true }, 202);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
