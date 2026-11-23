// Real graph proof: a user's company-qualified actors never pool business
// rights. Affiliation gates context entry separately from actor business grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestSpiceDb, type TestSpiceDb } from "../../testing/start-test-spice-db.js";
import {
  type Authorization,
  relationshipWrite,
  type ResourceRef,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";
import { ACTING_COMPANY_SCHEMA, actingCompanyFixture } from "./testing/acting-company-fixture.js";

describe("acting-company isolation through Authorization", () => {
  let spiceDb: TestSpiceDb;
  let authorization: Authorization;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();
    const adapter = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
    await adapter.writeSchema(ACTING_COMPANY_SCHEMA);
    authorization = adapter;
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it("keeps A's viewer role separate from B's manager role on the same document", async () => {
    const f = actingCompanyFixture("same-document");
    await authorization.writeRelationships(f.facts);

    await assertReachable(
      authorization,
      f.user,
      "enter_company_workspace",
      [f.companyA, f.companyB],
      [f.companyA.id, f.companyB.id],
    );
    await assertReachable(
      authorization,
      f.actorA,
      "view",
      [f.shared, f.bOnly, f.independent],
      [f.shared.id, f.independent.id],
    );
    await assertReachable(authorization, f.actorA, "manage", [f.shared, f.bOnly, f.independent], []);
    await assertReachable(
      authorization,
      f.actorB,
      "view",
      [f.shared, f.bOnly, f.independent],
      [f.shared.id, f.bOnly.id, f.independent.id],
    );
    await assertReachable(
      authorization,
      f.actorB,
      "manage",
      [f.shared, f.bOnly, f.independent],
      [f.shared.id, f.independent.id],
    );
  });

  it("grants neither the authenticated user nor an unrelated actor any business fallback", async () => {
    const f = actingCompanyFixture("no-fallback");
    await authorization.writeRelationships(f.facts);
    const stranger = { type: f.actorA.type, id: `${f.companyA.id}/stranger` };

    for (const subject of [f.user, stranger]) {
      for (const permission of ["view", "manage"]) {
        await assertReachable(authorization, subject, permission, [f.shared, f.bOnly, f.independent], []);
      }
    }
  });

  it("external workspace attachment grants operation but not host-company affiliation", async () => {
    const f = actingCompanyFixture("external-attachment");
    await authorization.writeRelationships([
      relationshipWrite(f.companyA, "owned_workspace", f.workspace),
      relationshipWrite(f.companyB, "affiliated_user", f.user),
      relationshipWrite(f.workspace, "attached_actor", f.actorB),
    ]);

    await assertReachable(authorization, f.user, "enter_company_workspace", [f.companyA, f.companyB], [f.companyB.id]);
    await assertReachable(authorization, f.actorB, "operate", [f.workspace], [f.workspace.id]);
    await assertReachable(authorization, f.actorA, "operate", [f.workspace], []);
  });

  it("direct workspace affiliation permits owner-company entry without company business grants", async () => {
    const f = actingCompanyFixture("workspace-affiliation");
    await authorization.writeRelationships([
      relationshipWrite(f.companyA, "owned_workspace", f.workspace),
      relationshipWrite(f.workspace, "affiliated_user", f.user),
      relationshipWrite(f.workspace, "attached_actor", f.actorA),
    ]);

    await assertReachable(authorization, f.user, "enter_company_workspace", [f.companyA, f.companyB], [f.companyA.id]);
    await assertReachable(authorization, f.actorA, "operate", [f.workspace], [f.workspace.id]);
    await assertReachable(authorization, f.actorA, "manage", [f.companyA, f.companyB], []);
    await expect(
      authorization.listDirectSubjects({
        resource: f.companyA,
        relation: "affiliated_user",
      }),
    ).resolves.toEqual([]);
  });

  it("revoking affiliation closes context entry even while an actor business tuple remains", async () => {
    const f = actingCompanyFixture("affiliation-revocation");
    await authorization.writeRelationships(f.facts);
    await assertReachable(
      authorization,
      f.user,
      "enter_company_workspace",
      [f.companyA, f.companyB],
      [f.companyA.id, f.companyB.id],
    );

    await authorization.deleteRelationships({
      resourceType: f.companyA.type,
      resourceId: f.companyA.id,
      relation: "affiliated_user",
      subject: f.user,
    });

    await assertReachable(authorization, f.user, "enter_company_workspace", [f.companyA, f.companyB], [f.companyB.id]);
    // The edge must recheck entry before accepting this actor. The actor ID
    // alone does not authenticate the person or establish current affiliation.
    await expect(
      authorization.listDirectSubjects({
        resource: f.share,
        relation: "viewer",
      }),
    ).resolves.toEqual([f.actorA]);
  });

  it("cannot combine B's manager grant with A's remaining sharing ceiling", async () => {
    const f = actingCompanyFixture("cross-company-ceiling");
    await authorization.writeRelationships(f.facts);
    await authorization.deleteRelationships({
      resourceType: f.share.type,
      resourceId: f.share.id,
      relation: "ceiling",
      subject: f.actorB,
    });

    await assertReachable(
      authorization,
      f.actorA,
      "view",
      [f.shared, f.bOnly, f.independent],
      [f.shared.id, f.independent.id],
    );
    await assertReachable(authorization, f.actorB, "view", [f.shared, f.bOnly, f.independent], [f.bOnly.id]);
    await assertReachable(authorization, f.actorB, "manage", [f.shared, f.bOnly, f.independent], []);
  });

  it("removing a warmed sharing ceiling revokes derived access but preserves an independent grant", async () => {
    const f = actingCompanyFixture("ceiling-revocation");
    await authorization.writeRelationships(f.facts);
    await assertReachable(
      authorization,
      f.actorA,
      "view",
      [f.shared, f.bOnly, f.independent],
      [f.shared.id, f.independent.id],
    );
    await assertReachable(
      authorization,
      f.actorB,
      "manage",
      [f.shared, f.bOnly, f.independent],
      [f.shared.id, f.independent.id],
    );

    await authorization.deleteRelationships({
      resourceType: f.share.type,
      resourceId: f.share.id,
      relation: "ceiling",
    });

    await assertReachable(authorization, f.actorA, "view", [f.shared, f.bOnly, f.independent], [f.independent.id]);
    await assertReachable(authorization, f.actorB, "view", [f.shared, f.bOnly, f.independent], [f.bOnly.id]);
    await assertReachable(authorization, f.actorB, "manage", [f.shared, f.bOnly, f.independent], []);
  });
});

async function assertReachable(
  authorization: Authorization,
  subject: SubjectRef,
  permission: string,
  candidates: readonly ResourceRef[],
  expectedIds: readonly string[],
): Promise<void> {
  const first = candidates[0];
  if (first === undefined) throw new Error("Graph assertion needs candidate resources");
  const listed = await authorization.lookupResources({
    subject,
    permission,
    resourceType: first.type,
  });
  expect([...listed].sort()).toEqual([...expectedIds].sort());
  for (const resource of candidates) {
    await expect(authorization.check({ subject, permission, resource })).resolves.toBe(
      expectedIds.includes(resource.id),
    );
  }
}
