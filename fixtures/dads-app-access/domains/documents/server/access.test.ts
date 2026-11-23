import { createAccessHarness } from "@dads-framework/access/testing";
import { describe, expect, it } from "vitest";

import {
  document,
  documentsAccessModel,
  organization,
  user,
} from "../access/index.js";
import { documentsRoutes } from "./routes.js";

describe("documents domain access boundaries", () => {
  it("inherits document access from org while keeping billing fail-closed", () => {
    const access = createAccessHarness(documentsAccessModel);
    const admin = access.actor(user, "admin");
    const member = access.actor(user, "member");
    const accountant = access.actor(user, "accountant");

    access.grant(organization.roles.admin, "org-1").to(admin);
    access.grant(organization.roles.member, "org-1").to(member);
    access
      .grant(document.roles.organization, "doc-1")
      .to(organization("org-1"));
    access
      .grant(organization.billing.roles.organization, "bill-1")
      .to(organization("org-1"));
    access
      .grant(organization.billing.roles.accountant, "bill-1")
      .to(accountant);

    access.assertCan(member, document.permissions.view, "doc-1");
    access.assertCannot(member, document.permissions.edit, "doc-1");
    access.assertCan(admin, document.permissions.edit, "doc-1");

    // Billing inherits only `manage`, never `view`, so org members stay blocked
    access.assertCannot(
      member,
      organization.billing.permissions.view,
      "bill-1",
    );
    access.assertCan(
      accountant,
      organization.billing.permissions.view,
      "bill-1",
    );
  });

  it("attaches permission guards to every document route", () => {
    const routes = documentsRoutes({
      findById: (documentId) =>
        Promise.resolve({ id: documentId, title: "Spec" }),
      renameInProtectedTx: (_actorId, documentId, title) =>
        Promise.resolve({ id: documentId, title }),
    });
    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.access.kind === "permission")).toBe(
      true,
    );
  });
});
