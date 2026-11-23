import { describe, expect, it } from "vitest";
import { answeringEachQuestionOnce } from "@dads-framework/core/runtime/request-work";

import { AnswerOnceAuthorization } from "./answer-once-authorization.js";
import { Authorization, relationshipWrite, type SpiceDbConsistencyToken, type SubjectRef } from "./authorization.js";
import { FakeAuthorization } from "./fake-authorization.js";
import { RecordingAuthorization } from "./recording-authorization.js";

class MinimalAuthorization extends Authorization {
  check(): Promise<boolean> {
    return Promise.resolve(false);
  }
  lookupResources(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  writeRelationships(): Promise<SpiceDbConsistencyToken> {
    return Promise.resolve("t1");
  }
  deleteRelationships(): Promise<SpiceDbConsistencyToken> {
    return Promise.resolve("t2");
  }
  relationshipExists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listDirectSubjects(): Promise<readonly SubjectRef[]> {
    return Promise.resolve([]);
  }
}

describe("relationshipWrite", () => {
  it("omits expiresAt when options are not supplied and carries expiresAt when given", () => {
    const resource = { type: "document", id: "doc-1" };
    const subject = { type: "user", id: "u-1" };
    const plain = relationshipWrite(resource, "viewer", subject);
    expect(plain).toEqual({ resource, relation: "viewer", subject });
    expect("expiresAt" in plain).toBe(false);

    const expiresAt = new Date("2026-12-01T00:00:00Z");
    const expiring = relationshipWrite(resource, "viewer", subject, {
      expiresAt,
    });
    expect(expiring).toEqual({
      resource,
      relation: "viewer",
      subject,
      expiresAt,
    });
  });
});

describe("FakeAuthorization expiration & lookupSubjects", () => {
  it("ignores expired tuples across check, lookupResources, lookupSubjects, and direct inspection", async () => {
    let currentTime = new Date("2026-06-01T12:00:00Z");
    const authz = new FakeAuthorization(
      {
        document: { view: ["viewer", "editor"] },
      },
      { now: () => currentTime },
    );

    const doc = { type: "document", id: "doc-1" };
    const alice = { type: "user", id: "alice" };
    const bob = { type: "user", id: "bob" };
    const expiry = new Date("2026-06-01T13:00:00Z");

    await authz.writeRelationships([
      relationshipWrite(doc, "viewer", alice, { expiresAt: expiry }),
      relationshipWrite(doc, "editor", bob),
    ]);

    expect(await authz.check({ subject: alice, permission: "view", resource: doc })).toBe(true);
    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "document",
      }),
    ).toEqual(["doc-1"]);
    expect(
      await authz.lookupSubjects({
        resource: doc,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice", "bob"], hasWildcard: false });
    expect(
      await authz.relationshipExists({
        resourceType: "document",
        resourceId: "doc-1",
        relation: "viewer",
      }),
    ).toBe(true);
    expect(await authz.listDirectSubjects({ resource: doc, relation: "viewer" })).toEqual([alice]);

    // Advance clock to exact expiration boundary: alice's grant is now expired.
    currentTime = new Date("2026-06-01T13:00:00Z");

    expect(await authz.check({ subject: alice, permission: "view", resource: doc })).toBe(false);
    expect(await authz.check({ subject: bob, permission: "view", resource: doc })).toBe(true);
    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "document",
      }),
    ).toEqual([]);
    expect(
      await authz.lookupSubjects({
        resource: doc,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["bob"], hasWildcard: false });
    expect(
      await authz.relationshipExists({
        resourceType: "document",
        resourceId: "doc-1",
        relation: "viewer",
      }),
    ).toBe(false);
    expect(await authz.listDirectSubjects({ resource: doc, relation: "viewer" })).toEqual([]);
  });

  it("reports wildcard grants via hasWildcard and filters by subjectType without usersets", async () => {
    const authz = new FakeAuthorization({
      document: { view: ["viewer", "public_share"] },
    });
    const doc = { type: "document", id: "doc-1" };
    authz.seed(
      relationshipWrite(doc, "viewer", { type: "user", id: "alice" }),
      relationshipWrite(doc, "viewer", {
        type: "group",
        id: "eng",
        relation: "member",
      }),
      relationshipWrite(doc, "public_share", { type: "user", id: "*" }),
      relationshipWrite(doc, "viewer", { type: "service", id: "bot-1" }),
    );

    expect(
      await authz.lookupSubjects({
        resource: doc,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: true });

    expect(
      await authz.lookupSubjects({
        resource: doc,
        permission: "view",
        subjectType: "service",
      }),
    ).toEqual({ subjects: ["bot-1"], hasWildcard: false });
  });
});

describe("RecordingAuthorization.lookupSubjects", () => {
  it("records subject-lookup questions and returns configured answers", async () => {
    const query = {
      resource: { type: "document", id: "doc-1" },
      permission: "view",
      subjectType: "user",
    };
    const recording = new RecordingAuthorization({
      subjectLookups: [{ query, answer: { subjects: ["u1", "u2"], hasWildcard: false } }],
    });

    const result = await recording.lookupSubjects(query);
    expect(result).toEqual({ subjects: ["u1", "u2"], hasWildcard: false });
    expect(recording.questions).toEqual([{ kind: "subject-lookup", query }]);
  });

  it("rejects duplicate subjectLookup answers", () => {
    const query = {
      resource: { type: "document", id: "doc-1" },
      permission: "view",
      subjectType: "user",
    };
    expect(
      () =>
        new RecordingAuthorization({
          subjectLookups: [
            { query, answer: { subjects: ["u1"], hasWildcard: false } },
            { query, answer: { subjects: ["u2"], hasWildcard: false } },
          ],
        }),
    ).toThrow(/duplicate subject-lookup answer/);
  });
});

describe("AnswerOnceAuthorization.lookupSubjects", () => {
  it("deduplicates lookupSubjects within a scope and forgets on writes", async () => {
    const query = {
      resource: { type: "document", id: "doc-1" },
      permission: "view",
      subjectType: "user",
    };
    const fake = new FakeAuthorization({ document: { view: ["viewer"] } });
    fake.seed(relationshipWrite(query.resource, "viewer", { type: "user", id: "u1" }));

    let calls = 0;
    const originalLookup = fake.lookupSubjects.bind(fake);
    fake.lookupSubjects = (q) => {
      calls += 1;
      return originalLookup(q);
    };

    const cached = new AnswerOnceAuthorization(fake);
    await answeringEachQuestionOnce(async () => {
      expect(await cached.lookupSubjects(query)).toEqual({
        subjects: ["u1"],
        hasWildcard: false,
      });
      expect(await cached.lookupSubjects(query)).toEqual({
        subjects: ["u1"],
        hasWildcard: false,
      });
      expect(calls).toBe(1);

      await cached.writeRelationships([relationshipWrite(query.resource, "viewer", { type: "user", id: "u2" })]);
      expect(await cached.lookupSubjects(query)).toEqual({
        subjects: ["u1", "u2"],
        hasWildcard: false,
      });
      expect(calls).toBe(2);
    });
  });

  it("rejects clearly when the underlying Authorization does not implement lookupSubjects", async () => {
    const cached = new AnswerOnceAuthorization(new MinimalAuthorization());
    await expect(
      cached.lookupSubjects({
        resource: { type: "document", id: "doc-1" },
        permission: "view",
        subjectType: "user",
      }),
    ).rejects.toThrow(/does not implement lookupSubjects/);
  });
});
