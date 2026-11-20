import type { SubjectRef } from "./authorization.js";

/**
 * Resolves the authenticated subject from an incoming request. The concrete
 * implementation lives with the identity wiring (Better Auth session lookup);
 * the guard depends only on this port so the authz lib stays vendor-free
 * (docs/architecture/engineering-principles.md §3).
 */
export type RequestHeaders = {
  headers: Record<string, string | string[] | undefined>;
  /** The request's path and query, when the caller has one. */
  readonly url?: string;
};

/**
 * Which credential authenticated the caller:
 * session cookie / opaque bearer refresh layer, a human access JWT, or a
 * device JWT. Recorded for diagnostics only — it never widens or narrows a
 * decision.
 */
export type AuthMethod = "session-cookie" | "access-jwt" | "device-jwt";

/** The authenticated subject plus the credential that produced it. */
export type ResolvedSubject = {
  readonly subject: SubjectRef;
  readonly method: AuthMethod;
  /**
   * When the caller last proved who they are on the session that
   * authenticated them, by a sign-in the server itself forced and checked
   * (the auth server stamps it as it makes the session), for the few writes
   * that ask for a recent sign-in. Present only when the resolver read a
   * session that carries the stamp; an ordinary sign-in, a JWT, or a
   * resolver that cannot say leaves it out, and such a write refuses.
   */
  readonly sessionReauthenticatedAt?: Date;
};

/**
 * Abstract class on purpose: it is both the TypeScript interface and the
 * wiring seam. Implemented by the importing app (for example a session lookup
 * in its identity layer); bound by the composition root.
 */
export abstract class RequestSubject {
  /** Returns the authenticated subject, or null when unauthenticated. */
  abstract resolve(request: RequestHeaders): Promise<SubjectRef | null>;

  /**
   * The same resolution, plus which credential answered. Optional so every
   * existing resolver and test fake stays valid: callers that want the
   * method fall back to `resolve` and record none.
   */
  resolveWithMethod?(request: RequestHeaders): Promise<ResolvedSubject | null>;
}
