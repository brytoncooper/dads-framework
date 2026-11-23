import { actor, anyOf, compileAccess, resource, world } from "@dads-framework/access";
import { proveAccess, proveWorld } from "@dads-framework/access/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { describe, expect, it } from "vitest";

import { PostgresAuthorization, preparePostgresChecks, relationshipSchemaMigration } from "./index.js";
import { provePostgresFilterParity } from "./testing.js";

function buildDocumentSchema() {
  const user = actor("user");
  const workspace = resource("app/workspace", {
    roles: { owner: user },
    can: ({ owner }) => ({ view: owner }),
  });
  const document = resource("app/document", {
    roles: {
      scope_workspace: workspace,
      viewer: user,
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

describe("@dads-framework/postgres-access/testing", () => {
  it("runs proveAccess, proveWorld, and provePostgresFilterParity against live PostgreSQL", async () => {
    const { user, workspace, document, model } = buildDocumentSchema();
    const postgres = await startUnmigratedTestPostgres({ attributed: false });

    try {
      const pool = postgres.pool;
      await pool.query(relationshipSchemaMigration.sql);
      await pool.query(`
        CREATE TABLE app_documents (
          id text PRIMARY KEY,
          workspace_id text NOT NULL
        );
      `);
      await pool.query(
        "INSERT INTO app_documents (id, workspace_id) VALUES ('doc-1', 'workspace-1'), ('doc-2', 'workspace-1'), ('doc-3', 'workspace-2')",
      );

      const authorization = new PostgresAuthorization({
        model,
        namespace: "pg_testing_helpers",
        executor: preparePostgresChecks(pool),
      });

      const alice = user("alice");
      const bob = user("bob");
      const stranger = user("stranger");

      await proveAccess(model, { authorization }, (scenario) => {
        scenario.grant(workspace.roles.owner, "workspace-1").to(alice);
        scenario.grant(document.roles.scope_workspace, "doc-1").to(workspace, "workspace-1");
        scenario.grant(document.roles.scope_workspace, "doc-2").to(workspace, "workspace-1");
        scenario.grant(document.roles.scope_workspace, "doc-3").to(workspace, "workspace-2");
        scenario.grant(document.roles.banned, "doc-2").to(alice);
        scenario.grant(document.roles.viewer, "doc-3").to(bob);

        scenario.assertCan(alice, document.permissions.view, "doc-1");
        scenario.assertCannot(alice, document.permissions.view, "doc-2");
        scenario.assertCan(bob, document.permissions.view, "doc-3");
        scenario.assertCannot(stranger, document.permissions.view, "doc-1");
        scenario.assertVisible(alice, document.permissions.view, ["doc-1"]);
      });

      await provePostgresFilterParity({
        db: pool,
        authorization,
        table: "app_documents",
        idColumn: "id",
        permission: document.permissions.view,
        scopeColumns: { scope_workspace: "workspace_id" },
        subjects: [alice, bob, stranger],
      });

      const worldCheck = world("postgres world proof", ({ user: person, entity, write, expect: expectAccess }) => {
        const carol = person("carol");
        write(workspace.roles.owner, "workspace-2").to(carol);
        write(document.roles.scope_workspace, "doc-3").to(entity(workspace, "workspace-2"));
        expectAccess(carol).can(document.permissions.view, "doc-3");
        expectAccess(carol).cannot(document.permissions.view, "doc-1");
      });
      await proveWorld(model, worldCheck, { authorization });

      // Deliberately corrupt FK to verify parity helper catches scopeColumns / resolveFilter drift
      await pool.query("UPDATE app_documents SET workspace_id = 'workspace-1' WHERE id = 'doc-3'");
      await expect(
        provePostgresFilterParity({
          db: pool,
          authorization,
          table: "app_documents",
          idColumn: "id",
          permission: document.permissions.view,
          scopeColumns: { scope_workspace: "workspace_id" },
          subjects: [alice],
        }),
      ).rejects.toThrow(/SQL leaked rows: \[doc-3\]/);
    } finally {
      await postgres.stop();
    }
  }, 60_000);
});
