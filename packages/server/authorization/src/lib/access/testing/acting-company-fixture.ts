import { relationshipWrite } from "@dads-framework/access/runtime";

// Test-only policy prototype. Production policy remains domain-owned access().
export const ACTING_COMPANY_SCHEMA = `
definition user {}
definition access_management/company_actor {}
definition test/organization {
  relation affiliated_user: user
  relation owned_workspace: test/workspace
  relation manager: access_management/company_actor
  permission enter_company_workspace = affiliated_user + owned_workspace->affiliated_user
  permission manage = manager
}
definition test/workspace {
  relation affiliated_user: user
  relation attached_actor: access_management/company_actor
  permission operate = attached_actor
}
definition test/sharing {
  relation viewer: access_management/company_actor
  relation manager: access_management/company_actor
  relation ceiling: access_management/company_actor
  permission view = (viewer + manager) & ceiling
  permission manage = manager & ceiling
}
definition test/document {
  relation shared_source: test/sharing
  relation independent_viewer: access_management/company_actor
  permission view = shared_source->view + independent_viewer
  permission manage = shared_source->manage
}
`;

/** Unique scenario IDs keep writes and revocations independent of test order. */
export function actingCompanyFixture(scenario: string) {
  const user = { type: "user", id: `${scenario}-user` };
  const companyA = { type: "test/organization", id: `${scenario}-a` };
  const companyB = { type: "test/organization", id: `${scenario}-b` };
  const actorA = {
    type: "access_management/company_actor",
    id: `${companyA.id}/${user.id}`,
  };
  const actorB = { ...actorA, id: `${companyB.id}/${user.id}` };
  const workspace = { type: "test/workspace", id: `${scenario}-workspace` };
  const share = { type: "test/sharing", id: `${scenario}-share` };
  const shared = { type: "test/document", id: `${scenario}-shared` };
  const bOnly = { type: "test/document", id: `${scenario}-b-only` };
  const independent = { type: "test/document", id: `${scenario}-independent` };
  const facts = [
    relationshipWrite(companyA, "affiliated_user", user),
    relationshipWrite(companyB, "affiliated_user", user),
    relationshipWrite(companyA, "owned_workspace", workspace),
    relationshipWrite(share, "viewer", actorA),
    relationshipWrite(share, "manager", actorB),
    relationshipWrite(share, "ceiling", actorA),
    relationshipWrite(share, "ceiling", actorB),
    relationshipWrite(shared, "shared_source", share),
    relationshipWrite(bOnly, "independent_viewer", actorB),
    relationshipWrite(independent, "shared_source", share),
    relationshipWrite(independent, "independent_viewer", actorA),
  ];
  return {
    user,
    companyA,
    companyB,
    actorA,
    actorB,
    workspace,
    share,
    shared,
    bOnly,
    independent,
    facts,
  };
}
