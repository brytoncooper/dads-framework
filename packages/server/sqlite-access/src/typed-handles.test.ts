import { DatabaseSync } from "node:sqlite";
import { actor, compileAccess, resource } from "@dads-framework/access";
import { createAccessClient } from "@dads-framework/access/runtime";
import { describe, expect, it } from "vitest";
import { createNodeSqliteExecutor } from "./sqlite-executor.js";
import { SqliteAuthorization } from "./sqlite-authorization.js";
import { sqliteRelationshipSchemaMigration } from "./sqlite-schema.js";

const user = actor("user");
const workspace = resource("workspace", {
  roles: { member: user },
  can: ({ member }) => ({ view: member }),
  children: {
    document: {
      inherit: "all",
      roles: { editor: user },
      can: ({ editor }) => ({ edit: editor }),
    },
  },
});
const model = compileAccess([workspace]);

describe("SqliteAuthorization typed permission handles", () => {
  it("supports authorization.can and typed PermissionToken in compileFilter", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sqliteRelationshipSchemaMigration.sql);
      db.exec("CREATE TABLE documents (id TEXT PRIMARY KEY)");
      db.exec("INSERT INTO documents (id) VALUES ('doc-1'), ('doc-2')");

      const authorization = new SqliteAuthorization({
        model,
        namespace: "app",
        executor: createNodeSqliteExecutor(db),
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });
      const access = createAccessClient(authorization);
      await access.add(user("alice"), workspace.document("doc-1").editor);

      expect(await authorization.can(user("alice"), workspace.document("doc-1").edit)).toBe(true);
      expect(await authorization.can(user("alice"), workspace.document.permissions.edit, "doc-1")).toBe(true);
      expect(await authorization.can(user("alice"), workspace.document.permissions.edit, "doc-2")).toBe(false);

      const typedFilter = authorization.compileFilter({
        subject: user("alice"),
        permission: workspace.document.permissions.edit,
        idColumn: "documents.id",
      });
      const wireFilter = authorization.compileFilter({
        subject: user("alice"),
        resourceType: workspace.document.wireName,
        permission: workspace.document.permissions.edit.permissionName,
        idColumn: "documents.id",
      });
      expect(typedFilter).toEqual(wireFilter);

      const rows = db.prepare(`SELECT id FROM documents WHERE ${typedFilter.sql}`).all(...typedFilter.values);
      expect(rows).toEqual([{ id: "doc-1" }]);
    } finally {
      db.close();
    }
  });
});
