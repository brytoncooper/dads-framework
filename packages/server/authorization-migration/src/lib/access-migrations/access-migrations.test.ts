import { DatabaseSync } from "node:sqlite";

import {
  access,
  accessModel,
  entityHandle,
  membersOf,
  through,
  wildcard,
  withExpiration,
} from "@dads-framework/access";
import {
  relationshipWrite,
  type RelationshipWrite,
} from "@dads-framework/access/runtime";
import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
} from "@dads-framework/sqlite-access";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuthorizationMigrationStore } from "../journal/journal-entry.js";
import { assertAccessMigrationsUpToDate } from "./assert-access-migrations-up-to-date.js";
import {
  copyParent,
  copyRole,
  defineAccessMigration,
  dropParent,
  dropRole,
} from "./define-access-migration.js";
import { runPostgresAccessMigrations } from "./run-postgres-access-migrations.js";
import { runSpiceDbAccessMigrations } from "./run-spicedb-access-migrations.js";
import { runSqliteAccessMigrations } from "./run-sqlite-access-migrations.js";
import type {
  PgMigrationExecutor,
  PgMigrationRow,
} from "./sql-migration-types.js";

const idSchema = z.string().min(1);
const user = entityHandle({ wireName: "user", idSchema });
const group = entityHandle({ wireName: "group", idSchema });
const workspace = entityHandle({ wireName: "workspace", idSchema });
const folder = entityHandle({ wireName: "folder", idSchema });
const document = entityHandle({ wireName: "document", idSchema });

const userDef = access(user, { roles: {}, permissions: () => ({}) });
const groupDef = access(group, {
  roles: { member: user },
  permissions: () => ({}),
});

const workspaceV1 = access(workspace, {
  roles: {
    member: [
      withExpiration(user),
      membersOf(groupDef.roles.member),
      wildcard(user),
    ],
  },
  permissions: ({ member }) => ({ view: [member] }),
});

const workspaceV2 = access(workspace, {
  roles: {
    editor: [
      withExpiration(user),
      membersOf(groupDef.roles.member),
      wildcard(user),
    ],
  },
  permissions: ({ editor }) => ({ view: [editor] }),
});

const modelV1 = accessModel([userDef, groupDef, workspaceV1]);
const modelV2 = accessModel([userDef, groupDef, workspaceV2]);

describe("defineAccessMigration & runSqliteAccessMigrations (node:sqlite)", () => {
  it("renames member -> editor while preserving access, usersets, wildcards, and expires_at, and is idempotent on rerun", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const statement of sqliteRelationshipSchemaMigration.statements) {
        db.exec(statement);
      }

      const fixedNowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
      const futureExpiry = new Date(fixedNowMs + 60 * 60 * 1000);
      const pastExpiry = new Date(fixedNowMs - 60 * 1000);
      const sqliteExec = createNodeSqliteExecutor(db);

      const authV1 = new SqliteAuthorization({
        model: modelV1,
        namespace: "tenant_a",
        executor: sqliteExec,
        now: () => new Date(fixedNowMs),
      });

      await authV1.writeRelationships([
        relationshipWrite({ type: "group", id: "eng" }, "member", {
          type: "user",
          id: "bob",
        }),
        relationshipWrite(
          { type: "workspace", id: "ws_1" },
          "member",
          { type: "user", id: "alice" },
          { expiresAt: futureExpiry },
        ),
        relationshipWrite(
          { type: "workspace", id: "ws_1" },
          "member",
          { type: "user", id: "expired_user" },
          { expiresAt: pastExpiry },
        ),
        relationshipWrite({ type: "workspace", id: "ws_1" }, "member", {
          type: "group",
          id: "eng",
          relation: "member",
        }),
        relationshipWrite({ type: "workspace", id: "ws_pub" }, "member", {
          type: "user",
          id: "*",
        }),
      ]);

      const migration = defineAccessMigration("0001_rename_member_to_editor", {
        from: modelV1,
        to: modelV2,
        steps: (ops) => [
          ops.copyRole(workspaceV1.roles.member, workspaceV2.roles.editor),
          ops.dropRole(workspaceV1.roles.member),
        ],
      });

      expect(migration.diff.requiresMigration).toBe(true);
      expect(migration.ops).toEqual([
        {
          kind: "copy-role",
          from: { resource: "workspace", role: "member" },
          to: { resource: "workspace", role: "editor" },
        },
        {
          kind: "drop-role",
          target: { resource: "workspace", role: "member" },
        },
      ]);

      // Before running migrations, assertAccessMigrationsUpToDate fails with missing ID.
      await expect(
        assertAccessMigrationsUpToDate({
          dialect: "sqlite",
          executor: db,
          namespace: "tenant_a",
          migrations: [migration],
        }),
      ).rejects.toThrow(/0001_rename_member_to_editor/);

      const firstRun = await runSqliteAccessMigrations({
        executor: db,
        namespace: "tenant_a",
        migrations: [migration],
        now: () => fixedNowMs,
      });
      expect(firstRun).toEqual({
        applied: ["0001_rename_member_to_editor"],
        skipped: [],
      });

      // Second run skips already-applied migration idempotently.
      const secondRun = await runSqliteAccessMigrations({
        executor: db,
        namespace: "tenant_a",
        migrations: [migration],
        now: () => fixedNowMs,
      });
      expect(secondRun).toEqual({
        applied: [],
        skipped: ["0001_rename_member_to_editor"],
      });

      // Up-to-date assertion now succeeds.
      await expect(
        assertAccessMigrationsUpToDate({
          dialect: "sqlite",
          executor: db,
          namespace: "tenant_a",
          migrations: [migration],
        }),
      ).resolves.toEqual({ applied: ["0001_rename_member_to_editor"] });

      // Old `member` rows are gone, `editor` rows preserve exact `expires_at` & `subject_relation`.
      const remainingOld = db
        .prepare(
          "SELECT COUNT(*) AS count FROM dad_authorization_relationship WHERE namespace = ? AND resource_kind = 'workspace' AND relation = 'member'",
        )
        .all("tenant_a");
      expect(remainingOld).toEqual([{ count: 0 }]);

      const aliceRow = db
        .prepare(
          "SELECT expires_at FROM dad_authorization_relationship WHERE namespace = ? AND resource_kind = 'workspace' AND resource_id = 'ws_1' AND relation = 'editor' AND subject_id = 'alice'",
        )
        .all("tenant_a");
      expect(aliceRow).toEqual([{ expires_at: futureExpiry.getTime() }]);

      // Verify live SqliteAuthorization under modelV2 grants identical access & enforces expiration.
      const authV2 = new SqliteAuthorization({
        model: modelV2,
        namespace: "tenant_a",
        executor: sqliteExec,
        now: () => new Date(fixedNowMs),
      });

      expect(
        await authV2.check({
          subject: { type: "user", id: "alice" },
          permission: "view",
          resource: { type: "workspace", id: "ws_1" },
        }),
      ).toBe(true);
      expect(
        await authV2.check({
          subject: { type: "user", id: "expired_user" },
          permission: "view",
          resource: { type: "workspace", id: "ws_1" },
        }),
      ).toBe(false);
      expect(
        await authV2.check({
          subject: { type: "user", id: "bob" },
          permission: "view",
          resource: { type: "workspace", id: "ws_1" },
        }),
      ).toBe(true);
      expect(
        await authV2.check({
          subject: { type: "user", id: "anyone" },
          permission: "view",
          resource: { type: "workspace", id: "ws_pub" },
        }),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("supports copyParent and dropParent helpers and reparents child resources", async () => {
    const folderDef = access(folder, {
      roles: { viewer: user },
      permissions: ({ viewer }) => ({ view: [viewer] }),
    });
    const docBefore = access(document, {
      roles: { folder: folder },
      permissions: ({ folder: parentFolder }) => ({
        view: [through(parentFolder, folderDef.permissions.view)],
      }),
    });
    const docAfter = access(document, {
      roles: { parent: folder },
      permissions: ({ parent }) => ({
        view: [through(parent, folderDef.permissions.view)],
      }),
    });

    const migration = defineAccessMigration("0002_reparent_doc", {
      from: accessModel([userDef, folderDef, docBefore]),
      to: accessModel([userDef, folderDef, docAfter]),
      steps: [
        copyParent(docBefore.roles.folder, docAfter.roles.parent),
        dropParent(docBefore.roles.folder),
      ],
    });

    const db = new DatabaseSync(":memory:");
    try {
      for (const statement of sqliteRelationshipSchemaMigration.statements) {
        db.exec(statement);
      }
      const sqliteExec = createNodeSqliteExecutor(db);
      const authBefore = new SqliteAuthorization({
        model: migration.from,
        namespace: "ns",
        executor: sqliteExec,
      });
      await authBefore.writeRelationships([
        relationshipWrite({ type: "folder", id: "f1" }, "viewer", {
          type: "user",
          id: "alice",
        }),
        relationshipWrite({ type: "document", id: "d1" }, "folder", {
          type: "folder",
          id: "f1",
        }),
      ]);

      await runSqliteAccessMigrations({
        executor: db,
        namespace: "ns",
        migrations: [migration],
      });

      const authAfter = new SqliteAuthorization({
        model: migration.to,
        namespace: "ns",
        executor: sqliteExec,
      });
      expect(
        await authAfter.check({
          subject: { type: "user", id: "alice" },
          permission: "view",
          resource: { type: "document", id: "d1" },
        }),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("runPostgresAccessMigrations & assertAccessMigrationsUpToDate", () => {
  it("runs pending migrations inside BEGIN/COMMIT, skips applied IDs, and rolls back on error", async () => {
    const queries: { readonly text: string; readonly values?: unknown[] }[] =
      [];
    const appliedIds = new Set<string>();
    let released = 0;
    let shouldFailDelete = false;

    const handleQuery = (
      text: string,
      values?: unknown[],
    ): Promise<{ readonly rows: readonly PgMigrationRow[] }> => {
      queries.push({ text: text.trim(), ...(values ? { values } : {}) });
      if (text.includes("SELECT id FROM dads_access_migrations")) {
        return Promise.resolve({
          rows: [...appliedIds].sort().map((id) => ({ id })),
        });
      }
      if (text.includes("INSERT INTO dads_access_migrations")) {
        const id = values?.[1];
        if (typeof id === "string") appliedIds.add(id);
      }
      if (shouldFailDelete && text.startsWith("DELETE FROM")) {
        return Promise.reject(new Error("simulated failure"));
      }
      return Promise.resolve({ rows: [] });
    };

    const executor: PgMigrationExecutor = {
      query: handleQuery,
      connect: () =>
        Promise.resolve({
          query: handleQuery,
          release: () => {
            released += 1;
          },
        }),
    };

    const migration = defineAccessMigration("0001_member_to_editor", {
      from: modelV1,
      to: modelV2,
      steps: [
        copyRole(workspaceV1.roles.member, workspaceV2.roles.editor),
        dropRole(workspaceV1.roles.member),
      ],
    });

    await expect(
      assertAccessMigrationsUpToDate({
        dialect: "postgres",
        executor,
        namespace: "prod",
        migrations: [migration],
      }),
    ).rejects.toThrow(/0001_member_to_editor/);

    const first = await runPostgresAccessMigrations({
      executor,
      namespace: "prod",
      migrations: [migration],
    });
    expect(first).toEqual({ applied: ["0001_member_to_editor"], skipped: [] });
    expect(released).toBe(1);
    expect(queries.some((q) => q.text === "BEGIN")).toBe(true);
    expect(queries.some((q) => q.text === "COMMIT")).toBe(true);

    const second = await runPostgresAccessMigrations({
      executor,
      namespace: "prod",
      migrations: [migration],
    });
    expect(second).toEqual({
      applied: [],
      skipped: ["0001_member_to_editor"],
    });

    await expect(
      assertAccessMigrationsUpToDate({
        dialect: "postgres",
        executor,
        namespace: "prod",
        migrations: [migration],
      }),
    ).resolves.toEqual({ applied: ["0001_member_to_editor"] });

    // Trigger failure inside a second migration and confirm ROLLBACK + client release.
    const migration2 = defineAccessMigration("0002_drop_editor", {
      from: modelV2,
      to: modelV1,
      steps: [dropRole(workspaceV2.roles.editor)],
    });
    shouldFailDelete = true;
    await expect(
      runPostgresAccessMigrations({
        executor,
        namespace: "prod",
        migrations: [migration, migration2],
      }),
    ).rejects.toThrow("simulated failure");
    expect(queries.some((q) => q.text === "ROLLBACK")).toBe(true);
    expect(released).toBe(2);
  });
});

describe("runSpiceDbAccessMigrations", () => {
  it("executes bridge schema, copies relationships, deletes old relation, and writes target schema", async () => {
    const schemas: string[] = [];
    const tuples: RelationshipWrite[] = [
      relationshipWrite({ type: "workspace", id: "ws_1" }, "member", {
        type: "user",
        id: "alice",
      }),
    ];

    const store: AuthorizationMigrationStore = {
      readSchema: () => Promise.resolve(schemas.at(-1) ?? ""),
      writeSchema: (schema) => {
        schemas.push(schema);
        return Promise.resolve();
      },
      readRelationshipPage: ({ resourceType }) =>
        Promise.resolve({
          relationships: tuples.filter((t) => t.resource.type === resourceType),
          nextCursor: null,
        }),
      writeRelationships: (writes) => {
        tuples.push(...writes);
        return Promise.resolve("tok-w");
      },
      deleteRelationships: (filter) => {
        for (let i = tuples.length - 1; i >= 0; i -= 1) {
          const item = tuples[i];
          if (
            item !== undefined &&
            item.resource.type === filter.resourceType &&
            (filter.relation === undefined || item.relation === filter.relation)
          ) {
            tuples.splice(i, 1);
          }
        }
        return Promise.resolve("tok-d");
      },
      deleteExactRelationship: () => Promise.resolve("tok-de"),
      listDirectSubjects: () => Promise.resolve([]),
      check: () => Promise.resolve(false),
    };

    const migration = defineAccessMigration("0001_member_to_editor", {
      from: modelV1,
      to: modelV2,
      steps: [
        copyRole(workspaceV1.roles.member, workspaceV2.roles.editor),
        dropRole(workspaceV1.roles.member),
      ],
    });

    const result = await runSpiceDbAccessMigrations({
      store,
      migrations: [migration],
    });

    expect(result).toEqual({ applied: ["0001_member_to_editor"] });
    expect(schemas).toHaveLength(2);
    const bridgeWorkspace = schemas[0]?.split("definition workspace")[1] ?? "";
    const targetWorkspace = schemas[1]?.split("definition workspace")[1] ?? "";
    expect(bridgeWorkspace).toContain("relation member:");
    expect(bridgeWorkspace).toContain("relation editor:");
    expect(targetWorkspace).not.toContain("relation member:");
    expect(targetWorkspace).toContain("relation editor:");
    expect(tuples).toEqual([
      relationshipWrite({ type: "workspace", id: "ws_1" }, "editor", {
        type: "user",
        id: "alice",
      }),
    ]);
  });
});
