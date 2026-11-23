import { createAccessHarness } from "@dads-framework/access/testing";
import { describe, expect, it } from "vitest";

import { accessModel, document, organization, user } from "./model.js";
import { recommendedIndexSql } from "./postgres.js";

describe("standalone document permissions", () => {
  it("enforces org inheritance, direct ownership, bans, and revocations without Docker", () => {
    const access = createAccessHarness(accessModel);
    const alice = access.actor(user, "alice");
    const bob = access.actor(user, "bob");
    const outsider = access.actor(user, "outsider");

    access.grant(organization.roles.admin, "org-1").to(alice);
    access.grant(organization.roles.member, "org-1").to(bob);
    access.grant(document.roles.org, "doc-1").to(organization("org-1"));
    access.grant(document.roles.owner, "doc-1").to(bob);

    access.assertMatrix(document, "doc-1", {
      permissions: [document.permissions.view, document.permissions.edit],
      cases: [
        [alice, ["allow", "allow"]],
        [bob, ["allow", "allow"]],
        [outsider, ["deny", "deny"]],
      ],
    });

    // An explicit ban overrides even org admin and direct ownership
    access.grant(document.roles.banned, "doc-1").to(bob);
    access.assertCannot(bob, document.permissions.view, "doc-1");
    access.assertCannot(bob, document.permissions.edit, "doc-1");

    // Lifting the ban restores access immediately
    access.revoke(document.roles.banned, "doc-1").from(bob);
    access.assertCan(bob, document.permissions.edit, "doc-1");
  });

  it("emits recommended composite indexes for column-backed foreign keys", () => {
    expect(recommendedIndexSql).toHaveLength(2);
    expect(recommendedIndexSql.join("\n")).toContain("org_id");
    expect(recommendedIndexSql.join("\n")).toContain("owner_id");
  });
});
