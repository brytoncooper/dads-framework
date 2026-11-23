import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startTestSpiceDb,
  type TestSpiceDb,
} from "../../testing/start-test-spice-db.js";
import {
  type PermissionQuery,
  relationshipWrite,
} from "@dads-framework/access/runtime";
import { runWithAuthorizationConsistency } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";

/**
 * Integration test against real SpiceDB (docs/architecture/authorization.md#testing):
 * exercises all four port methods, arrow permissions, and the no-relationship
 * denial case. Uses a test-only inline schema — the committed .zed fragments
 * are validated by `zed validate` in CI and land with their domains.
 *
 * ORDER-INDEPENDENT by construction (readiness plan Task C): the shared
 * baseline (doc-1's grants) is seeded once in `beforeAll` and never mutated;
 * every test that WRITES uses its own subjects and resource ids, so no test can
 * change what another asserts, under any shuffle seed.
 */
const TEST_SCHEMA = `
definition user {}

definition test/document {
  relation owner: user
  relation viewer: user
  permission view = owner + viewer
  permission edit = owner
}
`;

// The immutable baseline, seeded in beforeAll: doc-1 with one owner + one viewer.
const OWNER = { type: "user", id: "owner-1" };
const VIEWER = { type: "user", id: "viewer-1" };
const STRANGER = { type: "user", id: "stranger-1" };
const DOC = { type: "test/document", id: "doc-1" };

describe("SpiceDbAuthorization (integration)", () => {
  let spiceDb: TestSpiceDb;
  let adapter: SpiceDbAuthorization;
  let defaultConsistencyAdapter: SpiceDbAuthorization;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();

    adapter = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      // Direct-subject assertions are immediate read-your-writes inspections,
      // so they require current data. Check and lookup enforce current graph
      // authority regardless of this separate display-read setting.
      consistency: "fully-consistent",
    });
    defaultConsistencyAdapter = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
    });
    await adapter.writeSchema(TEST_SCHEMA);
    await adapter.writeRelationships([
      relationshipWrite(DOC, "owner", OWNER),
      relationshipWrite(DOC, "viewer", VIEWER),
    ]);
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it("writeRelationships returns a SpiceDbConsistencyToken and check honors the grant", async () => {
    // Own subjects + resource: this test's writes are invisible to every other.
    const writeOwner = { type: "user", id: "owner-write" };
    const writeViewer = { type: "user", id: "viewer-write" };
    const writeDoc = { type: "test/document", id: "doc-write" };

    const token = await adapter.writeRelationships([
      relationshipWrite(writeDoc, "owner", writeOwner),
      relationshipWrite(writeDoc, "viewer", writeViewer),
    ]);
    expect(token.length).toBeGreaterThan(0);

    await expect(
      adapter.check({
        subject: writeOwner,
        permission: "edit",
        resource: writeDoc,
      }),
    ).resolves.toBe(true);
    await expect(
      adapter.check({
        subject: writeViewer,
        permission: "view",
        resource: writeDoc,
      }),
    ).resolves.toBe(true);
    // viewer has view but not edit — permission math lives in the schema
    await expect(
      adapter.check({
        subject: writeViewer,
        permission: "edit",
        resource: writeDoc,
      }),
    ).resolves.toBe(false);
  });

  it("denies a subject with no relationship path — the denial case", async () => {
    // Reads only the immutable baseline; STRANGER is never granted anywhere.
    await expect(
      adapter.check({ subject: STRANGER, permission: "view", resource: DOC }),
    ).resolves.toBe(false);
  });

  it("bulk checks preserve the individual grant and denial answers in order", async () => {
    const queries: readonly PermissionQuery[] = [
      { subject: OWNER, permission: "edit", resource: DOC },
      { subject: VIEWER, permission: "view", resource: DOC },
      { subject: VIEWER, permission: "edit", resource: DOC },
      { subject: STRANGER, permission: "view", resource: DOC },
    ];
    const individual: boolean[] = [];
    for (const query of queries) individual.push(await adapter.check(query));

    const bulk = await adapter.checkMany(queries);

    expect(bulk).toEqual([true, true, false, false]);
    expect(bulk).toEqual(individual);
  });

  it("bulk checks deny remotely revoked authority immediately despite stale tokens", async () => {
    const subject = { type: "user", id: "bulk-revocation-reader" };
    const revoked = { ...DOC, id: "doc-bulk-revoked" };
    const retained = { ...DOC, id: "doc-bulk-retained" };
    const oldToken = await adapter.writeRelationships([
      relationshipWrite(revoked, "viewer", subject),
      relationshipWrite(retained, "viewer", subject),
    ]);
    const queries = [revoked, retained].map((resource) => ({
      subject,
      resource,
      permission: "view",
      consistencyToken: oldToken,
    }));
    await expect(defaultConsistencyAdapter.checkMany(queries)).resolves.toEqual(
      [true, true],
    );

    await adapter.deleteRelationships({
      resourceType: revoked.type,
      resourceId: revoked.id,
      relation: "viewer",
      subject,
    });

    await runWithAuthorizationConsistency(oldToken, async () => {
      await expect(
        defaultConsistencyAdapter.checkMany(queries),
      ).resolves.toEqual([false, true]);
    });
  });

  it("preserves ordered decisions across multiple 128-item RPC batches", async () => {
    const queries = Array.from({ length: 257 }, (_, index) => ({
      subject: index % 3 === 0 ? OWNER : STRANGER,
      resource: DOC,
      permission: "view",
    }));

    await expect(adapter.checkMany(queries)).resolves.toEqual(
      queries.map((_, index) => index % 3 === 0),
    );
  });

  it("lookupResources returns exactly the reachable ids", async () => {
    // VIEWER's grants are exactly: the baseline doc-1 + this test's doc-2 —
    // no other test writes for VIEWER, so this set is exact under any order.
    await adapter.writeRelationships([
      relationshipWrite({ ...DOC, id: "doc-2" }, "viewer", VIEWER),
    ]);
    const viewerDocs = await adapter.lookupResources({
      subject: VIEWER,
      permission: "view",
      resourceType: "test/document",
    });
    expect([...viewerDocs].sort()).toEqual(["doc-1", "doc-2"]);

    const strangerDocs = await adapter.lookupResources({
      subject: STRANGER,
      permission: "view",
      resourceType: "test/document",
    });
    expect(strangerDocs).toEqual([]);
  });

  it("deleteRelationships revokes access", async () => {
    // Own subject + resource: the delete can never unseat another test's grant.
    const deleteViewer = { type: "user", id: "viewer-delete" };
    const deleteDoc = { ...DOC, id: "doc-3" };
    await adapter.writeRelationships([
      relationshipWrite(deleteDoc, "viewer", deleteViewer),
    ]);
    await adapter.deleteRelationships({
      resourceType: "test/document",
      resourceId: "doc-3",
      relation: "viewer",
    });
    await expect(
      adapter.check({
        subject: deleteViewer,
        permission: "view",
        resource: deleteDoc,
      }),
    ).resolves.toBe(false);
  });

  it("listDirectSubjects returns direct relation holders only", async () => {
    const listOwner = { type: "user", id: "owner-list" };
    const listViewer = { type: "user", id: "viewer-list" };
    const listDoc = { type: "test/document", id: "doc-list" };
    await adapter.writeRelationships([
      relationshipWrite(listDoc, "owner", listOwner),
      relationshipWrite(listDoc, "viewer", listViewer),
    ]);
    const owners = await adapter.listDirectSubjects({
      resource: listDoc,
      relation: "owner",
    });
    expect(owners).toEqual([listOwner]);
    const viewers = await adapter.listDirectSubjects({
      resource: listDoc,
      relation: "viewer",
    });
    expect(viewers).toEqual([listViewer]);
  });

  it("lookupResources at the write token sees the new grant under minimize-latency", async () => {
    const owner = { type: "user", id: "owner-fresh" };
    const doc = { type: "test/document", id: "doc-fresh" };
    const token = await defaultConsistencyAdapter.writeRelationships([
      relationshipWrite(doc, "owner", owner),
    ]);
    expect(token.length).toBeGreaterThan(0);

    const visible = await defaultConsistencyAdapter.lookupResources({
      subject: owner,
      permission: "view",
      resourceType: doc.type,
      consistencyToken: token,
    });

    expect(visible).toContain(doc.id);
  });

  it("a guard-grade direct-subject read cannot return the deleted roster", async () => {
    const removed = { type: "user", id: "guard-removed" };
    const remaining = { type: "user", id: "guard-remaining" };
    const guardDoc = { type: "test/document", id: "doc-guard" };
    await defaultConsistencyAdapter.writeRelationships([
      relationshipWrite(guardDoc, "owner", removed),
      relationshipWrite(guardDoc, "owner", remaining),
    ]);
    await defaultConsistencyAdapter.deleteRelationships({
      resourceType: guardDoc.type,
      resourceId: guardDoc.id,
      relation: "owner",
      subject: removed,
    });

    const subjects = await defaultConsistencyAdapter.listDirectSubjects({
      resource: guardDoc,
      relation: "owner",
      consistency: "fully-consistent",
    });

    expect(subjects).toEqual([remaining]);
  });
});
