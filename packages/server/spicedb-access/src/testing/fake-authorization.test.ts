import { describe, expect, it } from "vitest";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";

const ORG = { type: "organizations/organization", id: "org-1" };
const ADMIN = { type: "user", id: "admin-1" };
const STRANGER = { type: "user", id: "stranger-9" };

function makeFake() {
  const fake = new FakeAuthorization({
    "organizations/organization": {
      view: ["admin", "member"],
      manage: ["admin"],
    },
  });
  fake.seed(relationshipWrite(ORG, "admin", ADMIN));
  return fake;
}

describe("FakeAuthorization", () => {
  it("grants permissions through the configured relation table", async () => {
    const fake = makeFake();
    await expect(
      fake.check({ subject: ADMIN, permission: "view", resource: ORG }),
    ).resolves.toBe(true);
    await expect(
      fake.check({ subject: ADMIN, permission: "manage", resource: ORG }),
    ).resolves.toBe(true);
  });

  it("denies a subject with no relationship path — the denial case", async () => {
    const fake = makeFake();
    await expect(
      fake.check({ subject: STRANGER, permission: "view", resource: ORG }),
    ).resolves.toBe(false);
  });

  it("looks up only resources the subject can reach", async () => {
    const fake = makeFake();
    fake.seed(
      relationshipWrite({ ...ORG, id: "org-2" }, "member", ADMIN),
      relationshipWrite({ ...ORG, id: "org-3" }, "admin", STRANGER),
    );
    await expect(
      fake.lookupResources({
        subject: ADMIN,
        permission: "view",
        resourceType: "organizations/organization",
      }),
    ).resolves.toEqual(expect.arrayContaining(["org-1", "org-2"]));
    await expect(
      fake.lookupResources({
        subject: ADMIN,
        permission: "manage",
        resourceType: "organizations/organization",
      }),
    ).resolves.toEqual(["org-1"]);
  });

  it("writeRelationships grants and deleteRelationships revokes", async () => {
    const fake = makeFake();
    const token = await fake.writeRelationships([
      relationshipWrite(ORG, "member", STRANGER),
    ]);
    expect(token).toMatch(/^fake-token-/);
    await expect(
      fake.check({ subject: STRANGER, permission: "view", resource: ORG }),
    ).resolves.toBe(true);

    await fake.deleteRelationships({
      resourceType: ORG.type,
      resourceId: ORG.id,
      relation: "member",
    });
    await expect(
      fake.check({ subject: STRANGER, permission: "view", resource: ORG }),
    ).resolves.toBe(false);
  });

  it("deleteRelationships with subject only removes that subject's tuple", async () => {
    const fake = makeFake();
    const other = { type: "user", id: "member-other" };
    fake.seed(
      relationshipWrite(ORG, "member", STRANGER),
      relationshipWrite(ORG, "member", other),
    );
    await fake.deleteRelationships({
      resourceType: ORG.type,
      resourceId: ORG.id,
      relation: "member",
      subject: STRANGER,
    });
    await expect(
      fake.listDirectSubjects({ resource: ORG, relation: "member" }),
    ).resolves.toEqual([other]);
  });

  it("listDirectSubjects returns only holders of the named relation", async () => {
    const fake = makeFake();
    fake.seed(relationshipWrite(ORG, "member", STRANGER));
    await expect(
      fake.listDirectSubjects({ resource: ORG, relation: "admin" }),
    ).resolves.toEqual([ADMIN]);
    await expect(
      fake.listDirectSubjects({ resource: ORG, relation: "member" }),
    ).resolves.toEqual([STRANGER]);
  });

  /**
   * REGRESSION (2026-08-04). `deleteRelationships` split each stored tuple with
   * `tuple.split("#", 2)`, which DISCARDS everything after the second separator
   * rather than keeping it — so a subject-set tuple lost its trailing
   * `#member`, the subject filter could never match, and the delete removed
   * NOTHING while returning a token. In a revocation test that is the failure
   * mode indistinguishable from success, and it can hide a subject set keeping
   * grants after a revocation reports completion.
   *
   * Fails against `split("#", 2)`; passes with the `indexOf`/`slice` form.
   */
  it("deletes a SUBJECT-SET tuple, whose subject carries its own relation", async () => {
    const fake = makeFake();
    const memberSet = {
      type: "access_management/permission_set",
      id: "set-1",
      relation: "member",
    };
    fake.seed(
      relationshipWrite(ORG, "member", memberSet),
      relationshipWrite(ORG, "member", STRANGER),
    );

    await fake.deleteRelationships({
      resourceType: ORG.type,
      resourceId: ORG.id,
      relation: "member",
      subject: memberSet,
    });

    // The set is gone and the bystander is untouched — a filter that matched
    // too broadly would take both.
    await expect(
      fake.listDirectSubjects({ resource: ORG, relation: "member" }),
    ).resolves.toEqual([STRANGER]);
  });

  it("keeps a subject-set tuple when the filter names a DIFFERENT subject relation", async () => {
    // The other half of the same bug: with the tail discarded, every subject
    // set on a resource looked identical, so deleting one would have taken its
    // siblings too.
    const fake = makeFake();
    const members = {
      type: "access_management/permission_set",
      id: "set-1",
      relation: "member",
    };
    const managers = {
      type: "access_management/permission_set",
      id: "set-1",
      relation: "manager",
    };
    fake.seed(
      relationshipWrite(ORG, "member", members),
      relationshipWrite(ORG, "member", managers),
    );

    await fake.deleteRelationships({
      resourceType: ORG.type,
      resourceId: ORG.id,
      relation: "member",
      subject: members,
    });

    await expect(
      fake.listDirectSubjects({ resource: ORG, relation: "member" }),
    ).resolves.toEqual([managers]);
  });
});
