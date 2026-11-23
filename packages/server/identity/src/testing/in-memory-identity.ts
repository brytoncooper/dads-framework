import type { Identity, IdentitySession } from "../identity-types.js";

export type InMemoryIdentitySessions = Readonly<Record<string, IdentitySession>>;

const SESSION_COOKIE = "dads_fixture_session";

function tokenFrom(headers: Headers): string | undefined {
  const prefix = `${SESSION_COOKIE}=`;
  return headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))
    ?.slice(prefix.length);
}

/** A cookie header value for a session explicitly seeded by a test. */
export function inMemoryIdentityCookie(key: string): string {
  return `${SESSION_COOKIE}=${key}`;
}

/** A stand-in for the verified-session boundary, driven by a test clock. */
export function inMemoryIdentity(seed: InMemoryIdentitySessions, now: () => Date): Identity {
  const sessions = new Map(Object.entries(seed));

  function sessionFor(headers: Headers): IdentitySession | null {
    const key = tokenFrom(headers);
    const session = key === undefined ? undefined : sessions.get(key);
    if (session === undefined || !session.account.emailVerified) return null;
    if (session.expiresAt.getTime() <= now().getTime()) return null;
    return session;
  }

  function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/get-session" && request.method === "GET") {
      return Promise.resolve(Response.json(sessionFor(request.headers)));
    }
    if (path === "/api/auth/sign-out" && request.method === "POST") {
      const key = tokenFrom(request.headers);
      if (key !== undefined) sessions.delete(key);
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.resolve(Response.json({ error: "not-found" }, { status: 404 }));
  }

  return {
    handle,
    readSession: (headers) => Promise.resolve(sessionFor(headers)),
  };
}
