// The HTTP edge must resolve the acting company before BOTH single-resource
// checks and list discovery, while retaining the login identity for audit.
import { describe, expect, it } from "vitest";

import type { SubjectRef } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";

import { fromParam, fromQuery } from "../route/access.js";
import { enforceAccess } from "./enforce-access.js";

const identity = { type: "user", id: "person" };
const actorA = { type: "test/company_actor", id: "a/person" };
const actorB = { type: "test/company_actor", id: "b/person" };
const resource = { type: "test/document", id: "shared" };
const companySource = fromQuery("actingOrganizationId");
const permissionAccess = {
  kind: "permission" as const,
  resourceType: resource.type,
  permission: "manage",
  resourceId: fromParam("id"),
  authorizationContext: companySource,
};
const visibilityAccess = {
  kind: "visibility" as const,
  resourceType: resource.type,
  permission: "manage",
  authorizationContext: companySource,
};

function setup() {
  const authorization = new FakeAuthorization({
    [resource.type]: { manage: ["manager"] },
  });
  // A legacy global grant is deliberate: ignoring the requested company
  // must be caught, even when the global user would pass the same check.
  for (const subject of [identity, actorB]) {
    authorization.seed({ resource, relation: "manager", subject });
  }
  const eligibleCompanies = new Set(["a", "b"]);
  const ports = {
    subjects: { resolve: () => Promise.resolve(identity) },
    authorization,
    lookups: authorization,
    authorizationContexts: {
      execute: (authenticatedSubject: SubjectRef, organizationId: unknown) => {
        if (
          typeof organizationId !== "string" ||
          !eligibleCompanies.has(organizationId)
        ) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          subject: organizationId === "a" ? actorA : actorB,
          authenticatedSubject,
          actingOrganizationId: organizationId,
        });
      },
    },
  };
  return { ports, eligibleCompanies };
}

function request(actingOrganizationId: unknown) {
  return {
    headers: {},
    params: { id: resource.id },
    query: { actingOrganizationId },
  };
}

describe("acting-company request enforcement", () => {
  it("does not borrow B's manager permission while acting through A", async () => {
    const { ports } = setup();
    await expect(
      enforceAccess(permissionAccess, request("a"), ports),
    ).resolves.toEqual({
      outcome: "not-found",
      subject: actorA,
      authenticatedSubject: identity,
    });
    await expect(
      enforceAccess(permissionAccess, request("b"), ports),
    ).resolves.toMatchObject({ outcome: "allow", subject: actorB });
  });

  it("uses the same scoped subject for collection discovery", async () => {
    const { ports } = setup();
    await expect(
      enforceAccess(visibilityAccess, request("a"), ports),
    ).resolves.toMatchObject({
      outcome: "allow",
      subject: actorA,
      visibleIds: [],
    });
    await expect(
      enforceAccess(visibilityAccess, request("b"), ports),
    ).resolves.toMatchObject({
      outcome: "allow",
      subject: actorB,
      visibleIds: [resource.id],
    });
  });

  it.each([undefined, null, "forged", ["b"], { id: "b" }])(
    "denies missing or forged context %j instead of using global permissions",
    async (organizationId) => {
      const { ports } = setup();
      for (const access of [permissionAccess, visibilityAccess]) {
        await expect(
          enforceAccess(access, request(organizationId), ports),
        ).resolves.toEqual({
          outcome: "not-found",
          subject: null,
          authenticatedSubject: identity,
        });
      }
    },
  );

  it("retains the authenticated identity separately from the business actor", async () => {
    const { ports } = setup();
    await expect(
      enforceAccess(permissionAccess, request("b"), ports),
    ).resolves.toMatchObject({
      outcome: "allow",
      subject: actorB,
      authenticatedSubject: identity,
    });
  });

  it("rechecks affiliation after a previous allowed request", async () => {
    const { ports, eligibleCompanies } = setup();
    await expect(
      enforceAccess(permissionAccess, request("b"), ports),
    ).resolves.toMatchObject({ outcome: "allow" });
    eligibleCompanies.delete("b");
    await expect(
      enforceAccess(permissionAccess, request("b"), ports),
    ).resolves.toEqual({
      outcome: "not-found",
      subject: null,
      authenticatedSubject: identity,
    });
  });

  it("requires authentication before resolving a company", async () => {
    const { ports } = setup();
    await expect(
      enforceAccess(permissionAccess, request("b"), {
        ...ports,
        subjects: { resolve: () => Promise.resolve(null) },
      }),
    ).resolves.toEqual({ outcome: "unauthenticated" });
  });

  it("refuses a company route when its resolver has not been wired", async () => {
    const { ports } = setup();
    const withoutResolver = {
      subjects: ports.subjects,
      authorization: ports.authorization,
      lookups: ports.lookups,
    };
    await expect(
      enforceAccess(permissionAccess, request("b"), withoutResolver),
    ).rejects.toThrow(
      "authorization-context route registered without a resolver",
    );
  });

  it("preserves explicit identity-context account routes", async () => {
    const { ports } = setup();
    await expect(
      enforceAccess({ kind: "session" }, request(undefined), ports),
    ).resolves.toMatchObject({ outcome: "allow", subject: identity });
  });
});
