import {
  actor,
  allOf,
  anyOf,
  compileAccess,
  emitZed,
  every,
  resource,
  roleToken,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "@dads-framework/spicedb-access";
import { startTestSpiceDb } from "@dads-framework/spicedb-access/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresAuthorization,
  relationshipExpirationMigration,
  relationshipSchemaMigration,
} from "./index.js";

const user = actor("user");
const groupMemberRef = roleToken("group", "member", user.handle);
const group = resource("group", {
  roles: { member: [user, groupMemberRef] },
  can: ({ member }) => ({ view: member }),
});
const workspace = resource("workspace", {
  roles: {
    member: [user, group.roles.member, user.anyone],
    banned: user,
  },
  can: ({ member, banned }) => ({
    view: member.unless(banned),
  }),
});
const folder = resource("folder", {
  parents: [workspace],
  recursive: true,
  roles: {
    viewer: [user, group.roles.member, user.anyone],
  },
  can: ({ parents, viewer }) => ({
    view: anyOf(viewer, parents.view),
  }),
});
const document = resource("document", {
  parents: [workspace, folder],
  roles: {
    editor: user,
    approved: user,
  },
  can: ({ parents, editor, approved }) => ({
    view: parents.view,
    publish: allOf(editor, approved),
  }),
});
const label = resource("label", {
  roles: { holder: [user, user.anyone] },
  can: ({ holder }) => ({ hold: holder }),
});
const classifiedDoc = resource("classified_doc", {
  roles: { required_label: label },
  can: ({ required_label }) => ({
    read: every(required_label).hold,
  }),
});

const parityModel = compileAccess([
  user,
  group,
  workspace,
  folder,
  document,
  label,
  classifiedDoc,
]);

describe("Live Postgres + SpiceDB parity for all 5 features", () => {
  const disposers: (() => Promise<void>)[] = [];
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>;
  let spice: Awaited<ReturnType<typeof startTestSpiceDb>>;
  let pgAuth: PostgresAuthorization;
  let spiceAuth: SpiceDbAuthorization;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    disposers.push(postgres.stop);
    spice = await startTestSpiceDb();
    disposers.push(spice.stop);
    await postgres.pool.query(relationshipSchemaMigration.sql);
    await postgres.pool.query(relationshipExpirationMigration.sql);

    pgAuth = new PostgresAuthorization({
      model: parityModel,
      namespace: "parity5",
      executor: postgres.pool,
    });
    spiceAuth = new SpiceDbAuthorization({
      endpoint: spice.endpoint,
      presharedKey: spice.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
    await spiceAuth.writeSchema(emitZed(parityModel));

    const acyclicTuples = [
      relationshipWrite({ type: "group", id: "eng" }, "member", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "group", id: "org_members" }, "member", {
        type: "group",
        id: "eng",
        relation: "member",
      }),
      relationshipWrite({ type: "workspace", id: "ws_1" }, "member", {
        type: "group",
        id: "org_members",
        relation: "member",
      }),
      relationshipWrite({ type: "workspace", id: "ws_1" }, "member", {
        type: "user",
        id: "bob",
      }),
      relationshipWrite({ type: "workspace", id: "ws_1" }, "banned", {
        type: "user",
        id: "bob",
      }),
      relationshipWrite({ type: "folder", id: "f1" }, "parent", {
        type: "workspace",
        id: "ws_1",
      }),
      relationshipWrite({ type: "folder", id: "f2" }, "parent", {
        type: "folder",
        id: "f1",
      }),
      relationshipWrite({ type: "folder", id: "f3" }, "parent", {
        type: "folder",
        id: "f2",
      }),
      relationshipWrite({ type: "folder", id: "f4" }, "parent", {
        type: "folder",
        id: "f3",
      }),
      relationshipWrite({ type: "document", id: "doc_deep" }, "parent", {
        type: "folder",
        id: "f4",
      }),
      relationshipWrite({ type: "document", id: "doc_direct" }, "parent", {
        type: "workspace",
        id: "ws_1",
      }),
      relationshipWrite({ type: "workspace", id: "ws_pub" }, "member", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "document", id: "doc_pub" }, "parent", {
        type: "workspace",
        id: "ws_pub",
      }),
      relationshipWrite({ type: "label", id: "l1" }, "holder", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "label", id: "l2" }, "holder", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "label", id: "l1" }, "holder", {
        type: "user",
        id: "dana",
      }),
      relationshipWrite(
        { type: "classified_doc", id: "c_one" },
        "required_label",
        { type: "label", id: "l1" },
      ),
      relationshipWrite(
        { type: "classified_doc", id: "c_two" },
        "required_label",
        { type: "label", id: "l1" },
      ),
      relationshipWrite(
        { type: "classified_doc", id: "c_two" },
        "required_label",
        { type: "label", id: "l2" },
      ),
    ];

    await pgAuth.writeRelationships(acyclicTuples);
    await spiceAuth.writeRelationships(acyclicTuples);
  }, 60_000);

  afterAll(async () => {
    for (const stop of disposers.reverse()) await stop();
  });

  it("matches live SpiceDB on polymorphic arrows, 4-level recursive folders, and throughAll", async () => {
    const cases = [
      {
        user: "alice",
        type: "document",
        id: "doc_deep",
        perm: "view",
        want: true,
      },
      {
        user: "alice",
        type: "document",
        id: "doc_direct",
        perm: "view",
        want: true,
      },
      {
        user: "bob",
        type: "document",
        id: "doc_deep",
        perm: "view",
        want: false,
      },
      {
        user: "stranger",
        type: "document",
        id: "doc_deep",
        perm: "view",
        want: false,
      },
      {
        user: "stranger",
        type: "document",
        id: "doc_pub",
        perm: "view",
        want: true,
      },
      {
        user: "alice",
        type: "classified_doc",
        id: "c_zero",
        perm: "read",
        want: false,
      },
      {
        user: "alice",
        type: "classified_doc",
        id: "c_one",
        perm: "read",
        want: true,
      },
      {
        user: "alice",
        type: "classified_doc",
        id: "c_two",
        perm: "read",
        want: true,
      },
      {
        user: "dana",
        type: "classified_doc",
        id: "c_one",
        perm: "read",
        want: true,
      },
      {
        user: "dana",
        type: "classified_doc",
        id: "c_two",
        perm: "read",
        want: false,
      },
    ];

    const queries = cases.map((entry) => ({
      subject: { type: "user", id: entry.user },
      permission: entry.perm,
      resource: { type: entry.type, id: entry.id },
    }));
    const pgBatch = await pgAuth.checkMany(queries);

    for (const [index, entry] of cases.entries()) {
      const q = queries[index];
      if (!q) throw new Error("missing query");
      const [pgAllowed, spiceAllowed] = await Promise.all([
        pgAuth.check(q),
        spiceAuth.check(q),
      ]);
      expect(pgAllowed).toBe(entry.want);
      expect(spiceAllowed).toBe(entry.want);
      expect(pgBatch[index]).toBe(entry.want);
    }

    for (const actor of ["alice", "bob", "dana"]) {
      const [pgDocs, spiceDocs] = await Promise.all([
        pgAuth.lookupResources({
          subject: { type: "user", id: actor },
          permission: "view",
          resourceType: "document",
        }),
        spiceAuth.lookupResources({
          subject: { type: "user", id: actor },
          permission: "view",
          resourceType: "document",
        }),
      ]);
      expect([...pgDocs].sort()).toEqual([...spiceDocs].sort());

      const [pgClassified, spiceClassified] = await Promise.all([
        pgAuth.lookupResources({
          subject: { type: "user", id: actor },
          permission: "read",
          resourceType: "classified_doc",
        }),
        spiceAuth.lookupResources({
          subject: { type: "user", id: actor },
          permission: "read",
          resourceType: "classified_doc",
        }),
      ]);
      expect([...pgClassified].sort()).toEqual([...spiceClassified].sort());
    }
  }, 30_000);

  it("terminates cleanly on cyclic folder data in Postgres", async () => {
    const cycAuth = new PostgresAuthorization({
      model: parityModel,
      namespace: "parity5_cyc",
      executor: postgres.pool,
    });
    await cycAuth.writeRelationships([
      relationshipWrite({ type: "folder", id: "cyc_a" }, "parent", {
        type: "folder",
        id: "cyc_b",
      }),
      relationshipWrite({ type: "folder", id: "cyc_b" }, "parent", {
        type: "folder",
        id: "cyc_a",
      }),
      relationshipWrite({ type: "folder", id: "cyc_a" }, "viewer", {
        type: "user",
        id: "carol",
      }),
      relationshipWrite({ type: "document", id: "doc_cyc" }, "parent", {
        type: "folder",
        id: "cyc_b",
      }),
    ]);

    expect(
      await cycAuth.check({
        subject: { type: "user", id: "carol" },
        permission: "view",
        resource: { type: "document", id: "doc_cyc" },
      }),
    ).toBe(true);
    expect(
      await cycAuth.check({
        subject: { type: "user", id: "stranger" },
        permission: "view",
        resource: { type: "document", id: "doc_cyc" },
      }),
    ).toBe(false);
    expect(
      await cycAuth.lookupSubjects({
        resource: { type: "document", id: "doc_cyc" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["carol"], hasWildcard: false });
  });

  it("executes transitive lookupSubjects live on Postgres across groups, folders, exclusions, wildcards, and throughAll", async () => {
    expect(
      await pgAuth.lookupSubjects({
        resource: { type: "document", id: "doc_deep" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });

    expect(
      await pgAuth.lookupSubjects({
        resource: { type: "document", id: "doc_pub" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: true });

    expect(
      await pgAuth.lookupSubjects({
        resource: { type: "classified_doc", id: "c_two" },
        permission: "read",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });

    expect(
      await pgAuth.lookupSubjects({
        resource: { type: "classified_doc", id: "c_zero" },
        permission: "read",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: false });
  });

  it("enforces expires_at live in Postgres and updates expiration on touch", async () => {
    const expAuth = new PostgresAuthorization({
      model: parityModel,
      namespace: "parity5_exp",
      executor: postgres.pool,
    });
    const ws = { type: "workspace", id: "ws_exp" };
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 300_000);

    await expAuth.writeRelationships([
      relationshipWrite(
        ws,
        "member",
        { type: "user", id: "expired_u" },
        { expiresAt: past },
      ),
      relationshipWrite(
        ws,
        "member",
        { type: "user", id: "active_u" },
        { expiresAt: future },
      ),
    ]);

    expect(
      await expAuth.check({
        subject: { type: "user", id: "expired_u" },
        permission: "view",
        resource: ws,
      }),
    ).toBe(false);
    expect(
      await expAuth.check({
        subject: { type: "user", id: "active_u" },
        permission: "view",
        resource: ws,
      }),
    ).toBe(true);
    expect(
      await expAuth.lookupSubjects({
        resource: ws,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["active_u"], hasWildcard: false });
    expect(
      await expAuth.listDirectSubjects({ resource: ws, relation: "member" }),
    ).toEqual([{ type: "user", id: "active_u" }]);

    await expAuth.writeRelationships([
      relationshipWrite(ws, "member", { type: "user", id: "expired_u" }),
    ]);
    expect(
      await expAuth.check({
        subject: { type: "user", id: "expired_u" },
        permission: "view",
        resource: ws,
      }),
    ).toBe(true);
  });
});
