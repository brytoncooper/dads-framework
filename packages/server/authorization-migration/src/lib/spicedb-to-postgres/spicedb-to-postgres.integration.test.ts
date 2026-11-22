import { v1 } from "@authzed/authzed-node";
import {
  actor,
  allOf,
  compileAccess,
  emitZed,
  resource,
  roleToken,
} from "@dads-framework/access";
import { SpiceDbAuthorization } from "@dads-framework/authorization";
import { startTestSpiceDb } from "@dads-framework/authorization/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { PostgresAuthorization } from "@dads-framework/postgres-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assertAccessMigrationsUpToDate,
  defineAccessMigration,
  runPostgresAccessMigrations,
} from "../access-migrations/index.js";
import type { SpiceDbExportedTuple } from "./authzed-client-adapter.js";
import { migrateSpiceDbToPostgres } from "./migrate-spicedb-to-postgres.js";
import { verifySpiceDbPostgresParity } from "./verify-parity.js";

const idSchema = z.string().min(1);
const user = actor("user", { id: idSchema });

const groupMemberRef = roleToken("group", "member", user.handle);
const groupAccess = resource("group", {
  id: idSchema,
  roles: { member: [user, groupMemberRef] },
  can: ({ member }) => ({ view: member }),
});
const workspaceAccess = resource("workspace", {
  id: idSchema,
  roles: {
    member: [user, user.expiring, groupAccess.roles.member, user.anyone],
    banned: user,
  },
  can: ({ member, banned }) => ({
    view: member.unless(banned),
  }),
});
const folderAccess = resource("folder", {
  id: idSchema,
  parents: [workspaceAccess],
  recursive: true,
  roles: {
    viewer: [user, user.expiring, groupAccess.roles.member],
  },
  can: ({ parents, viewer }) => ({
    view: [viewer, parents.view],
  }),
});
const documentAccess = resource("document", {
  id: idSchema,
  parents: [workspaceAccess, folderAccess],
  roles: {
    editor: [user, user.expiring],
    approved: user,
  },
  can: ({ parents, editor, approved }) => ({
    view: parents.view,
    publish: allOf(editor, approved),
  }),
});

const liveModel = compileAccess([
  user,
  groupAccess,
  workspaceAccess,
  folderAccess,
  documentAccess,
]);

function makeRelationship(
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  options?: { readonly subjectRelation?: string; readonly expiresAt?: Date },
): v1.RelationshipUpdate {
  const expiresAt = options?.expiresAt;
  return v1.RelationshipUpdate.create({
    operation: v1.RelationshipUpdate_Operation.TOUCH,
    relationship: v1.Relationship.create({
      resource: v1.ObjectReference.create({
        objectType: resourceType,
        objectId: resourceId,
      }),
      relation,
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectType: subjectType,
          objectId: subjectId,
        }),
        ...(options?.subjectRelation === undefined
          ? {}
          : { optionalRelation: options.subjectRelation }),
      }),
      ...(expiresAt === undefined
        ? {}
        : {
            optionalExpiresAt: {
              seconds: String(Math.floor(expiresAt.getTime() / 1000)),
              nanos: (expiresAt.getTime() % 1000) * 1_000_000,
            },
          }),
    }),
  });
}

describe("Live Docker SpiceDB -> Postgres migration & parity", () => {
  const disposers: (() => Promise<void>)[] = [];
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>;
  let spice: Awaited<ReturnType<typeof startTestSpiceDb>>;
  let rawSpiceClient: v1.ZedClientInterface;
  let spiceAuth: SpiceDbAuthorization;
  const activeExpiry = new Date(
    Math.floor((Date.now() + 600_000) / 1000) * 1000,
  );
  const expiredAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    disposers.push(postgres.stop);
    spice = await startTestSpiceDb();
    disposers.push(spice.stop);

    rawSpiceClient = v1.NewClient(
      spice.presharedKey,
      spice.endpoint,
      v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED,
    );
    disposers.push(() => {
      rawSpiceClient.close();
      return Promise.resolve();
    });

    spiceAuth = new SpiceDbAuthorization({
      endpoint: spice.endpoint,
      presharedKey: spice.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });

    await spiceAuth.writeSchema(emitZed(liveModel));

    const updates: v1.RelationshipUpdate[] = [
      makeRelationship("group", "eng", "member", "user", "alice"),
      makeRelationship("group", "all_staff", "member", "group", "eng", {
        subjectRelation: "member",
      }),
      makeRelationship("workspace", "ws_1", "member", "group", "all_staff", {
        subjectRelation: "member",
      }),
      makeRelationship("workspace", "ws_1", "member", "user", "bob"),
      makeRelationship("workspace", "ws_1", "banned", "user", "bob"),
      makeRelationship("workspace", "ws_1", "member", "user", "temp_active", {
        expiresAt: activeExpiry,
      }),
      makeRelationship("workspace", "ws_1", "member", "user", "temp_expired", {
        expiresAt: expiredAt,
      }),
      makeRelationship("workspace", "ws_pub", "member", "user", "*"),
      makeRelationship("folder", "f1", "parent", "workspace", "ws_1"),
      makeRelationship("folder", "f2", "parent", "folder", "f1"),
      makeRelationship("document", "doc_deep", "parent", "folder", "f2"),
      makeRelationship("document", "doc_pub", "parent", "workspace", "ws_pub"),
      makeRelationship("document", "doc_deep", "editor", "user", "alice", {
        expiresAt: activeExpiry,
      }),
      makeRelationship("document", "doc_deep", "approved", "user", "alice"),
      makeRelationship("document", "doc_deep", "editor", "user", "carol"),
    ];

    await rawSpiceClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({ updates }),
    );
  }, 60_000);

  afterAll(async () => {
    for (const stop of disposers.reverse()) await stop();
  });

  it("migrates schema and streaming tuples from live SpiceDB into Postgres with 100% parity (0 mismatches)", async () => {
    const collectedTuples: SpiceDbExportedTuple[] = [];
    const migrationResult = await migrateSpiceDbToPostgres({
      spiceDb: rawSpiceClient,
      postgres: postgres.pool,
      namespace: "live_migration",
      batchSize: 4,
      onBatch: (batch) => collectedTuples.push(...batch),
    });

    expect(migrationResult.schemaZed).toContain("use expiration");
    expect(migrationResult.schemaZed).toContain("definition document");
    expect(migrationResult.generatedTypeScript).toContain("user.expiring");
    expect(migrationResult.generatedTypeScript).toContain("compileAccess(");
    expect(migrationResult.definitions.map((d) => d.wireName).sort()).toEqual([
      "document",
      "folder",
      "group",
      "user",
      "workspace",
    ]);
    // 15 tuples were written; SpiceDB ExportBulkRelationships omits the 1 already-expired tuple,
    // exporting the 14 active tuples (including active expiring grants with optional_expires_at).
    expect(migrationResult.exportedCount).toBe(14);
    expect(migrationResult.writtenCount).toBe(14);
    expect(migrationResult.zedToken).toBeTruthy();

    // Rerunning migration is idempotent and keeps row count identical.
    const rerun = await migrateSpiceDbToPostgres({
      spiceDb: rawSpiceClient,
      postgres: postgres.pool,
      namespace: "live_migration",
      batchSize: 5,
    });
    expect(rerun.writtenCount).toBe(14);

    const countRow = await postgres.pool.query(
      "SELECT COUNT(*)::int AS count FROM dad_authorization_relationship WHERE namespace = $1",
      ["live_migration"],
    );
    expect(countRow.rows[0]).toEqual({ count: 14 });

    // Confirm expiring grant preserved exact expires_at timestamp in Postgres.
    const expiryRow = await postgres.pool.query<{
      readonly expires_at: Date | null;
    }>(
      "SELECT expires_at FROM dad_authorization_relationship WHERE namespace = $1 AND resource_kind = 'workspace' AND resource_id = 'ws_1' AND relation = 'member' AND subject_id = 'temp_active'",
      ["live_migration"],
    );
    const storedExpiry = expiryRow.rows[0]?.expires_at;
    expect(storedExpiry).toBeInstanceOf(Date);
    if (storedExpiry instanceof Date) {
      expect(storedExpiry.getTime()).toBe(activeExpiry.getTime());
    }

    const pgAuth = new PostgresAuthorization({
      model: liveModel,
      namespace: "live_migration",
      executor: postgres.pool,
    });

    const parity = await verifySpiceDbPostgresParity({
      spiceDb: spiceAuth,
      postgres: pgAuth,
      definitions: migrationResult.definitions,
      tuples: collectedTuples,
      checkQueries: [
        {
          subject: { type: "user", id: "temp_active" },
          permission: "view",
          resource: { type: "document", id: "doc_deep" },
        },
        {
          subject: { type: "user", id: "temp_expired" },
          permission: "view",
          resource: { type: "document", id: "doc_deep" },
        },
        {
          subject: { type: "user", id: "bob" },
          permission: "view",
          resource: { type: "document", id: "doc_deep" },
        },
        {
          subject: { type: "user", id: "alice" },
          permission: "publish",
          resource: { type: "document", id: "doc_deep" },
        },
        {
          subject: { type: "user", id: "carol" },
          permission: "publish",
          resource: { type: "document", id: "doc_deep" },
        },
      ],
    });

    expect(parity.total).toBeGreaterThan(20);
    expect(parity.mismatches).toEqual([]);
    expect(parity.matched).toBe(parity.total);

    // Explicitly verify expiring grant semantics on both engines.
    expect(
      await pgAuth.check({
        subject: { type: "user", id: "temp_active" },
        permission: "view",
        resource: { type: "document", id: "doc_deep" },
      }),
    ).toBe(true);
    expect(
      await pgAuth.check({
        subject: { type: "user", id: "temp_expired" },
        permission: "view",
        resource: { type: "document", id: "doc_deep" },
      }),
    ).toBe(false);
  }, 30_000);

  it("runs connected Postgres access migrations live and enforces assertAccessMigrationsUpToDate", async () => {
    const workspaceV2 = resource("workspace", {
      id: idSchema,
      roles: {
        participant: [
          user,
          user.expiring,
          groupAccess.roles.member,
          user.anyone,
        ],
        banned: user,
      },
      can: ({ participant, banned }) => ({
        view: participant.unless(banned),
      }),
    });
    const folderV2 = resource("folder", {
      id: idSchema,
      parents: [workspaceV2],
      recursive: true,
      roles: {
        viewer: [user, user.expiring, groupAccess.roles.member],
      },
      can: ({ parents, viewer }) => ({
        view: [viewer, parents.view],
      }),
    });
    const documentV2 = resource("document", {
      id: idSchema,
      parents: [workspaceV2, folderV2],
      roles: {
        editor: [user, user.expiring],
        approved: user,
      },
      can: ({ parents, editor, approved }) => ({
        view: parents.view,
        publish: allOf(editor, approved),
      }),
    });
    const modelV2 = compileAccess([
      user,
      groupAccess,
      workspaceV2,
      folderV2,
      documentV2,
    ]);

    const migration = defineAccessMigration(
      "0001_workspace_member_to_participant",
      {
        from: liveModel,
        to: modelV2,
        steps: (ops) => [
          ops.copyRole(
            workspaceAccess.roles.member,
            workspaceV2.roles.participant,
          ),
          ops.dropRole(workspaceAccess.roles.member),
        ],
      },
    );

    await expect(
      assertAccessMigrationsUpToDate({
        dialect: "postgres",
        executor: postgres.pool,
        namespace: "live_migration",
        migrations: [migration],
      }),
    ).rejects.toThrow(/0001_workspace_member_to_participant/);

    const first = await runPostgresAccessMigrations({
      executor: postgres.pool,
      namespace: "live_migration",
      migrations: [migration],
    });
    expect(first).toEqual({
      applied: ["0001_workspace_member_to_participant"],
      skipped: [],
    });

    const second = await runPostgresAccessMigrations({
      executor: postgres.pool,
      namespace: "live_migration",
      migrations: [migration],
    });
    expect(second).toEqual({
      applied: [],
      skipped: ["0001_workspace_member_to_participant"],
    });

    await expect(
      assertAccessMigrationsUpToDate({
        dialect: "postgres",
        executor: postgres.pool,
        namespace: "live_migration",
        migrations: [migration],
      }),
    ).resolves.toEqual({
      applied: ["0001_workspace_member_to_participant"],
    });

    const pgAuthV2 = new PostgresAuthorization({
      model: modelV2,
      namespace: "live_migration",
      executor: postgres.pool,
    });
    expect(
      await pgAuthV2.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "document", id: "doc_deep" },
      }),
    ).toBe(true);
    expect(
      await pgAuthV2.check({
        subject: { type: "user", id: "temp_active" },
        permission: "view",
        resource: { type: "document", id: "doc_deep" },
      }),
    ).toBe(true);
    expect(
      await pgAuthV2.check({
        subject: { type: "user", id: "temp_expired" },
        permission: "view",
        resource: { type: "document", id: "doc_deep" },
      }),
    ).toBe(false);
    expect(
      await pgAuthV2.check({
        subject: { type: "user", id: "bob" },
        permission: "view",
        resource: { type: "document", id: "doc_deep" },
      }),
    ).toBe(false);
  });
});
