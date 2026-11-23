import { actor, anyOf, compileAccess, resource } from "@dads-framework/access";
import { proveAccess } from "@dads-framework/access/testing";
import { describe, expect, it } from "vitest";

import { createSqliteTestAuthorization, proveSqliteFilterParity } from "./testing.js";

function buildDocumentSchema() {
  const user = actor("user");
  const workspace = resource("app/workspace", {
    roles: { owner: user.expiring },
    can: ({ owner }) => ({ view: owner }),
  });
  const document = resource("app/document", {
    roles: {
      scope_workspace: workspace,
      viewer: user.expiring,
      banned: user,
    },
    can: ({ scope_workspace, viewer, banned }) => ({
      view: anyOf(scope_workspace.view, viewer).unless(banned),
    }),
  });
  return {
    user,
    workspace,
    document,
    model: compileAccess([user, workspace, document]),
  };
}

describe("@dads-framework/sqlite-access/testing", () => {
  it("runs recorded scenarios with time travel and proves SQL filter parity in memory", async () => {
    const { user, workspace, document, model } = buildDocumentSchema();
    using testEnv = createSqliteTestAuthorization(model);

    testEnv.db.exec("CREATE TABLE app_documents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);");
    const insertDoc = testEnv.db.prepare("INSERT INTO app_documents (id, workspace_id) VALUES (?, ?)");
    insertDoc.run("doc-1", "workspace-1");
    insertDoc.run("doc-2", "workspace-1");
    insertDoc.run("doc-3", "workspace-2");

    const alice = user("alice");
    const bob = user("bob");
    const stranger = user("stranger");

    await proveAccess(model, { authorization: testEnv.authorization, clock: testEnv.clock }, (scenario) => {
      scenario.grant(workspace.roles.owner, "workspace-1").to(alice);
      scenario.grant(document.roles.scope_workspace, "doc-1").to(workspace, "workspace-1");
      scenario.grant(document.roles.scope_workspace, "doc-2").to(workspace, "workspace-1");
      scenario.grant(document.roles.scope_workspace, "doc-3").to(workspace, "workspace-2");
      scenario.grant(document.roles.banned, "doc-2").to(alice);
      scenario.grant(document.roles.viewer, "doc-3").expiringIn("30m").to(bob);

      scenario.assertCan(alice, document.permissions.view, "doc-1");
      scenario.assertCannot(alice, document.permissions.view, "doc-2");
      scenario.assertCan(bob, document.permissions.view, "doc-3");
      scenario.assertVisible(alice, document.permissions.view, ["doc-1"]);

      scenario.advanceTime("1h");
      scenario.assertCannot(bob, document.permissions.view, "doc-3");
    });

    await proveSqliteFilterParity({
      db: testEnv.db,
      authorization: testEnv.authorization,
      table: "app_documents",
      idColumn: "id",
      permission: document.permissions.view,
      scopeColumns: { scope_workspace: "workspace_id" },
      subjects: [alice, bob, stranger],
    });

    // Deliberately break the FK column to verify parity helper reports the exact leak
    testEnv.db.exec("UPDATE app_documents SET workspace_id = 'workspace-1' WHERE id = 'doc-3'");
    await expect(
      proveSqliteFilterParity({
        db: testEnv.db,
        authorization: testEnv.authorization,
        table: "app_documents",
        idColumn: "id",
        permission: document.permissions.view,
        scopeColumns: { scope_workspace: "workspace_id" },
        subjects: [alice],
      }),
    ).rejects.toThrow(/compileFilter\(scopeColumns\)[\s\S]*SQL leaked rows: \[doc-3\]/);
  });
});
