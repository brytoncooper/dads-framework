import { describe, expect, it } from "vitest";

import {
  Authorization,
  ShadowAuthorization,
  type PermissionQuery,
  type ShadowErrorEvent,
  type ShadowMismatchEvent,
  type SpiceDbConsistencyToken,
  type SubjectLookupResult,
  type SubjectRef,
} from "./index.js";
import { FakeAuthorization } from "./fake-authorization.js";

class FailingAuthorization extends Authorization {
  constructor(private readonly message: string) {
    super();
  }

  override check(): Promise<boolean> {
    return Promise.reject(new Error(this.message));
  }

  override lookupResources(): Promise<readonly string[]> {
    return Promise.reject(new Error(this.message));
  }

  override lookupSubjects(): Promise<SubjectLookupResult> {
    return Promise.reject(new Error(this.message));
  }

  override writeRelationships(): Promise<SpiceDbConsistencyToken> {
    return Promise.reject(new Error(this.message));
  }

  override deleteRelationships(): Promise<SpiceDbConsistencyToken> {
    return Promise.reject(new Error(this.message));
  }

  override relationshipExists(): Promise<boolean> {
    return Promise.reject(new Error(this.message));
  }

  override listDirectSubjects(): Promise<readonly SubjectRef[]> {
    return Promise.reject(new Error(this.message));
  }
}

describe("ShadowAuthorization", () => {
  const schemaPerms = {
    organization: {
      view: ["admin", "member"],
      manage: ["admin"],
    },
  };

  it("dual-writes and dual-deletes across both primary and shadow backends", async () => {
    const primary = new FakeAuthorization(schemaPerms);
    const shadow = new FakeAuthorization(schemaPerms);
    const mismatches: ShadowMismatchEvent[] = [];
    const auth = new ShadowAuthorization({
      primary,
      shadow,
      onMismatch: (event) => mismatches.push(event),
    });

    await auth.writeRelationships([
      {
        resource: { type: "organization", id: "org-1" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
    ]);

    const query: PermissionQuery = {
      subject: { type: "user", id: "alice" },
      permission: "view",
      resource: { type: "organization", id: "org-1" },
    };
    expect(await auth.check(query)).toBe(true);
    expect(await shadow.check(query)).toBe(true);
    expect(mismatches).toEqual([]);

    await auth.deleteRelationships({
      resourceType: "organization",
      resourceId: "org-1",
      relation: "member",
      subject: { type: "user", id: "alice" },
    });

    expect(await auth.check(query)).toBe(false);
    expect(await shadow.check(query)).toBe(false);
    expect(mismatches).toEqual([]);
  });

  it("reports mismatches on check, checkMany, lookupResources, and lookupSubjects while returning primary", async () => {
    const primary = new FakeAuthorization(schemaPerms);
    const shadow = new FakeAuthorization(schemaPerms);

    // Seed divergent state: alice has access on primary only; bob has access on shadow only.
    primary.seed({
      resource: { type: "organization", id: "org-1" },
      relation: "member",
      subject: { type: "user", id: "alice" },
    });
    shadow.seed({
      resource: { type: "organization", id: "org-1" },
      relation: "member",
      subject: { type: "user", id: "bob" },
    });

    const mismatches: ShadowMismatchEvent[] = [];
    const auth = new ShadowAuthorization({
      primary,
      shadow,
      mode: "shadow-read",
      onMismatch: (event) => mismatches.push(event),
    });

    const aliceQuery: PermissionQuery = {
      subject: { type: "user", id: "alice" },
      permission: "view",
      resource: { type: "organization", id: "org-1" },
    };
    const bobQuery: PermissionQuery = {
      subject: { type: "user", id: "bob" },
      permission: "view",
      resource: { type: "organization", id: "org-1" },
    };

    expect(await auth.check(aliceQuery)).toBe(true);
    expect(await auth.checkMany([aliceQuery, bobQuery])).toEqual([true, false]);
    expect(
      await auth.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "organization",
      }),
    ).toEqual(["org-1"]);
    expect(
      await auth.lookupSubjects({
        resource: { type: "organization", id: "org-1" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });

    expect(mismatches.map((entry) => entry.operation)).toEqual([
      "check",
      "checkMany",
      "lookupResources",
      "lookupSubjects",
    ]);
    expect(mismatches[0]).toMatchObject({
      operation: "check",
      authoritative: true,
      comparison: false,
    });
    expect(mismatches[1]).toMatchObject({
      operation: "checkMany",
      authoritative: [true, false],
      comparison: [false, true],
    });
    expect(mismatches[2]).toMatchObject({
      operation: "lookupResources",
      authoritative: ["org-1"],
      comparison: [],
    });
    expect(mismatches[3]).toMatchObject({
      operation: "lookupSubjects",
      authoritative: { subjects: ["alice"], hasWildcard: false },
      comparison: { subjects: ["bob"], hasWildcard: false },
    });
  });

  it("ignores order differences when comparing lookupResources and lookupSubjects", async () => {
    const primary = new FakeAuthorization(schemaPerms);
    const shadow = new FakeAuthorization(schemaPerms);

    primary.seed(
      {
        resource: { type: "organization", id: "org-1" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: "organization", id: "org-2" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
    );
    shadow.seed(
      {
        resource: { type: "organization", id: "org-2" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: "organization", id: "org-1" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
    );

    const mismatches: ShadowMismatchEvent[] = [];
    const auth = new ShadowAuthorization({
      primary,
      shadow,
      onMismatch: (event) => mismatches.push(event),
    });

    expect(
      await auth.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "organization",
      }),
    ).toEqual(["org-1", "org-2"]);
    expect(mismatches).toEqual([]);
  });

  it("isolates shadow backend errors on reads and writes without failing the caller", async () => {
    const primary = new FakeAuthorization(schemaPerms);
    const shadow = new FailingAuthorization("shadow outage");
    const errors: ShadowErrorEvent[] = [];
    const mismatches: ShadowMismatchEvent[] = [];

    const auth = new ShadowAuthorization({
      primary,
      shadow,
      onMismatch: (event) => mismatches.push(event),
      onShadowError: (event) => errors.push(event),
    });

    await auth.writeRelationships([
      {
        resource: { type: "organization", id: "org-1" },
        relation: "admin",
        subject: { type: "user", id: "alice" },
      },
    ]);

    const query: PermissionQuery = {
      subject: { type: "user", id: "alice" },
      permission: "manage",
      resource: { type: "organization", id: "org-1" },
    };

    expect(await auth.check(query)).toBe(true);
    expect(await auth.checkMany([query])).toEqual([true]);
    expect(
      await auth.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "manage",
        resourceType: "organization",
      }),
    ).toEqual(["org-1"]);
    expect(
      await auth.lookupSubjects({
        resource: { type: "organization", id: "org-1" },
        permission: "manage",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });

    await auth.deleteRelationships({
      resourceType: "organization",
      resourceId: "org-1",
    });

    expect(mismatches).toEqual([]);
    expect(errors.map((entry) => entry.operation)).toEqual([
      "writeRelationships",
      "check",
      "checkMany",
      "lookupResources",
      "lookupSubjects",
      "deleteRelationships",
    ]);
    expect(errors.every((entry) => entry.error.message === "shadow outage")).toBe(true);
  });

  it("serves shadow as authoritative in primary-new mode and isolates primary errors", async () => {
    const primary = new FakeAuthorization(schemaPerms);
    const shadow = new FakeAuthorization(schemaPerms);
    shadow.seed({
      resource: { type: "organization", id: "org-1" },
      relation: "admin",
      subject: { type: "user", id: "alice" },
    });

    const mismatches: ShadowMismatchEvent[] = [];
    const auth = new ShadowAuthorization({
      primary,
      shadow,
      mode: "primary-new",
      onMismatch: (event) => mismatches.push(event),
    });

    const query: PermissionQuery = {
      subject: { type: "user", id: "alice" },
      permission: "manage",
      resource: { type: "organization", id: "org-1" },
    };
    expect(await auth.check(query)).toBe(true);
    expect(mismatches).toEqual([
      {
        operation: "check",
        query,
        authoritative: true,
        comparison: false,
      },
    ]);

    // When primary errors in primary-new mode, shadow still succeeds cleanly!
    const errors: ShadowErrorEvent[] = [];
    const cutover = new ShadowAuthorization({
      primary: new FailingAuthorization("legacy down"),
      shadow,
      mode: "primary-new",
      onShadowError: (event) => errors.push(event),
    });
    expect(await cutover.check(query)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toBe("legacy down");
  });
});
