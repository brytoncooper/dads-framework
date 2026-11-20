/** Release graph inspection must paginate real vendor cursors without losing usersets, and exact retirement must preserve sibling userset facts. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestSpiceDb,
  type TestSpiceDb,
} from "../../testing/start-test-spice-db.js";
import { type RelationshipWrite } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";

const SCHEMA = `
definition user {}
definition test/group {
  relation member: user
}
definition test/document {
  relation viewer: test/group | test/group#member
}
definition test/exact_document {
  relation viewer: test/group | test/group#member
}
definition test/other {
  relation viewer: user
}
`;

describe("SpiceDB relationship-page maintenance port", () => {
  let vendor: TestSpiceDb;
  let adapter: SpiceDbAuthorization;
  beforeAll(async () => {
    vendor = await startTestSpiceDb();
    adapter = new SpiceDbAuthorization({
      endpoint: vendor.endpoint,
      presharedKey: vendor.presharedKey,
      insecure: true,
    });
    await adapter.writeSchema(SCHEMA);
  }, 120_000);
  afterAll(async () => vendor.stop());

  it("returns all 1001 unique usersets in bounded pages then an empty terminal page", async () => {
    const facts: RelationshipWrite[] = Array.from(
      { length: 1001 },
      (_, index) => ({
        resource: {
          type: "test/document",
          id: `page-${String(index).padStart(4, "0")}`,
        },
        relation: "viewer",
        subject: {
          type: "test/group",
          id: `group-${index}`,
          relation: "member",
        },
      }),
    );
    await adapter.writeRelationships(facts.slice(0, 1000));
    await adapter.writeRelationships(facts.slice(1000));
    await adapter.writeRelationships([
      {
        resource: { type: "test/other", id: "excluded" },
        relation: "viewer",
        subject: { type: "user", id: "person" },
      },
    ]);
    const first = await adapter.readRelationshipPage({
      resourceType: "test/document",
    });
    expect(first.relationships).toHaveLength(1000);
    if (first.nextCursor === null)
      throw new Error("Expected first resume cursor");
    const second = await adapter.readRelationshipPage({
      resourceType: "test/document",
      cursor: first.nextCursor,
    });
    expect(second.relationships).toHaveLength(1);
    if (second.nextCursor === null)
      throw new Error("Expected final fact cursor");
    expect(second.nextCursor).not.toBe(first.nextCursor);
    const terminal = await adapter.readRelationshipPage({
      resourceType: "test/document",
      cursor: second.nextCursor,
    });
    expect(terminal).toEqual({ relationships: [], nextCursor: null });
    const observed = [...first.relationships, ...second.relationships];
    expect(new Set(observed.map((entry) => JSON.stringify(entry))).size).toBe(
      1001,
    );
    expect(observed.every((entry) => entry.subject.relation === "member")).toBe(
      true,
    );
    expect(observed.map((entry) => JSON.stringify(entry)).sort()).toEqual(
      facts.map((entry) => JSON.stringify(entry)).sort(),
    );
  });

  it("deletes only the exact direct fact while preserving the same subject object's userset", async () => {
    const direct: RelationshipWrite = {
      resource: { type: "test/exact_document", id: "exact-delete" },
      relation: "viewer",
      subject: { type: "test/group", id: "same-group" },
    };
    const userset: RelationshipWrite = {
      ...direct,
      subject: { ...direct.subject, relation: "member" },
    };
    await adapter.writeRelationships([direct, userset]);
    await adapter.deleteExactRelationship(direct);
    expect(
      await adapter.listDirectSubjects({
        resource: direct.resource,
        relation: "viewer",
        consistency: "fully-consistent",
      }),
    ).toEqual([userset.subject]);
    await adapter.writeRelationships([direct]);
    await adapter.deleteExactRelationship(userset);
    expect(
      await adapter.listDirectSubjects({
        resource: direct.resource,
        relation: "viewer",
        consistency: "fully-consistent",
      }),
    ).toEqual([direct.subject]);
  });
});
