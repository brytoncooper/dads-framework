/**
 * What: the decision breadcrumbs `enforceAccess` hands back — which access
 * declaration decided the request, which permission was settled against which
 * resource, and how the caller authenticated.
 * Why: the request log records the settled decision, and enforcement is the
 * only step that knows it. The widening is additive: allow and deny outcomes
 * are unchanged, and a resolver that cannot report an auth method still
 * enforces exactly as it did before.
 */
import { describe, expect, it } from "vitest";
import type {
  ResolvedSubject,
  SubjectRef,
} from "@dads-framework/access/runtime";
import {
  publicAccess,
  requireSession,
  type RouteAccess,
} from "../route/access.js";
import {
  enforceAccess,
  type AccessDecision,
  type AccessDenial,
  type AccessPorts,
  type SubjectResolver,
} from "./enforce-access.js";

const USER: SubjectRef = { type: "user", id: "user-1" };

const permissionAccess: RouteAccess = {
  kind: "permission",
  resourceType: "test/ticket",
  permission: "manage",
  resourceId: { kind: "param", name: "ticketId" },
};

const visibilityAccess: RouteAccess = {
  kind: "visibility",
  resourceType: "test/ticket",
  permission: "view",
};

const request = {
  headers: {},
  params: { ticketId: "ticket-1" },
  url: "/tickets/ticket-1",
};

/** A resolver that reports HOW it authenticated (the widened port). */
function reportingSubjects(): SubjectResolver {
  const reported: ResolvedSubject = { subject: USER, method: "session-cookie" };
  return {
    resolve: () => Promise.resolve(USER),
    resolveWithMethod: () => Promise.resolve(reported),
  };
}

/** The narrow resolver every pre-existing fake still is. */
function methodlessSubjects(): SubjectResolver {
  return { resolve: () => Promise.resolve(USER) };
}

function portsFor(
  subjects: SubjectResolver,
  checkResult: boolean,
  denials?: AccessDenial[],
): AccessPorts {
  return {
    subjects,
    authorization: { check: () => Promise.resolve(checkResult) },
    lookups: { lookupResources: () => Promise.resolve(["ticket-1"]) },
    ...(denials === undefined
      ? {}
      : { onDenied: (denial: AccessDenial) => denials.push(denial) }),
  };
}

/** Narrow to the allow arm so the breadcrumbs can be read directly. */
function allowOf(
  decision: AccessDecision,
): Extract<AccessDecision, { outcome: "allow" }> {
  if (decision.outcome !== "allow") {
    throw new Error(`expected an allow decision, got ${decision.outcome}`);
  }
  return decision;
}

describe("enforceAccess decision breadcrumbs", () => {
  it("reports the settled permission, resource and auth method on a permission route", async () => {
    const decision = allowOf(
      await enforceAccess(
        permissionAccess,
        request,
        portsFor(reportingSubjects(), true),
      ),
    );

    expect(decision.accessKind).toBe("permission");
    expect(decision.permission).toBe("manage");
    expect(decision.resource).toEqual({ type: "test/ticket", id: "ticket-1" });
    expect(decision.authMethod).toBe("session-cookie");
  });

  it("reports a session route as session-decided, with no permission settled", async () => {
    const decision = allowOf(
      await enforceAccess(
        requireSession(),
        request,
        portsFor(reportingSubjects(), true),
      ),
    );

    expect(decision.accessKind).toBe("session");
    expect(decision.permission).toBeUndefined();
    expect(decision.resource).toBeUndefined();
    expect(decision.authMethod).toBe("session-cookie");
  });

  it("reports the visibility permission on a set question, with no single resource", async () => {
    const decision = allowOf(
      await enforceAccess(
        visibilityAccess,
        request,
        portsFor(reportingSubjects(), true),
      ),
    );

    expect(decision.accessKind).toBe("visibility");
    expect(decision.permission).toBe("view");
    expect(decision.resource).toBeUndefined();
    expect(decision.visibleIds).toEqual(["ticket-1"]);
  });

  it("names a public route without resolving a subject or an auth method", async () => {
    const decision = allowOf(
      await enforceAccess(
        publicAccess(),
        request,
        portsFor(reportingSubjects(), true),
      ),
    );

    expect(decision.accessKind).toBe("public");
    expect(decision.subject).toBeNull();
    expect(decision.authMethod).toBeUndefined();
  });

  it("still enforces through a resolver that cannot report a method", async () => {
    const decision = allowOf(
      await enforceAccess(
        permissionAccess,
        request,
        portsFor(methodlessSubjects(), true),
      ),
    );

    expect(decision.permission).toBe("manage");
    expect(decision.authMethod).toBeUndefined();
  });

  it("takes a reporting resolver's 'nobody' as final, never a second opinion", async () => {
    const contradictory: SubjectResolver = {
      resolve: () => Promise.resolve(USER),
      resolveWithMethod: () => Promise.resolve(null),
    };

    await expect(
      enforceAccess(permissionAccess, request, portsFor(contradictory, true)),
    ).resolves.toEqual({ outcome: "unauthenticated" });
  });

  it("carries the auth method on the denial breadcrumb", async () => {
    const denials: AccessDenial[] = [];

    await expect(
      enforceAccess(
        permissionAccess,
        request,
        portsFor(reportingSubjects(), false, denials),
      ),
    ).resolves.toEqual({
      outcome: "not-found",
      subject: USER,
      authenticatedSubject: USER,
    });
    expect(denials).toEqual([
      {
        subjectType: "user",
        subjectId: "user-1",
        permission: "manage",
        resourceType: "test/ticket",
        resourceId: "ticket-1",
        url: "/tickets/ticket-1",
        authMethod: "session-cookie",
      },
    ]);
  });
});
