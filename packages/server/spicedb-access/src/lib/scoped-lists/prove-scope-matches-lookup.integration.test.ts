/**
 * What/why: the proof harness is what every adopting model leans on to show
 * its SQL scope selects exactly what SpiceDB's `lookupResources` returns. Here
 * the harness proves itself on a small world whose subjects each reach the
 * records through a different plan operator — column, join, derived + tag,
 * not over a join, a sparse direct grant, via, a not after a via, a NULL scope
 * column under not, and nothing at all — and fails with a readable diff when
 * one SQL binding is wrong.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DrizzleHandle } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres, type TestPostgres } from "@dads-framework/postgres/testing";
import { deterministicUuid } from "@dads-framework/postgres/testing/deterministic-uuid";

import { proveScopeMatchesLookup } from "../../testing/prove-scope-matches-lookup.js";
import { startTestSpiceDb, type TestSpiceDb } from "../../testing/start-test-spice-db.js";
import { relationshipWrite, type RelationshipWrite, type SubjectRef } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "../access/spice-db-authorization.js";
import { scopeSqlBindings } from "./scope-sql-bindings.js";
import {
  createFixtureTables,
  fixtureAccess,
  fixtureZed,
  folderScope,
  folderShares,
  folders,
  folderSql,
  folderSqlRoles,
  Folder,
  Member,
  sheets,
  sheetSql,
  Sheet,
  Site,
} from "./testing/scoped-list-fixture.js";

const id = (name: string, counter: number) => deterministicUuid(`scoped-list-${name}`, counter);

const S1 = id("site", 1);
const S2 = id("site", 2);
const S3 = id("site", 3);

const F = [1, 2, 3, 4, 5, 6, 7].map((counter) => id("folder", counter));
const [F1, F2, F3, F4, F5, F6, F7] = F;
const H = [1, 2, 3, 4].map((counter) => id("sheet", counter));
const [H1, H2, H3, H4] = H;

const member = (name: string): SubjectRef => ({
  type: Member.wireName,
  id: name,
});
const alice = member("alice"); // member of S1: home column, share join
const bob = member("bob"); // manager of S2: views S2, manages S2 sheets
const carol = member("carol"); // auditor of S3, blocked on S2: not over a join
const dave = member("dave"); // assignee of F6: sparse direct grant
const frank = member("frank"); // archivist of S1: derived + tag
const gina = member("gina"); // member of S1, blocked on S2: not after a via
const erin = member("erin"); // nothing

type FolderRow = {
  readonly id: string;
  readonly homeSiteId: string | null;
  readonly archived: boolean;
  readonly sharedWith: readonly string[];
  readonly assignee?: SubjectRef;
};

type SheetRow = {
  readonly id: string;
  readonly folderId: string;
  readonly siteId: string | null;
};

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("fixture id missing");
  return value;
}

const folderRows: readonly FolderRow[] = [
  { id: required(F1), homeSiteId: S1, archived: false, sharedWith: [] },
  { id: required(F2), homeSiteId: S1, archived: true, sharedWith: [S2] },
  { id: required(F3), homeSiteId: S1, archived: true, sharedWith: [] },
  { id: required(F4), homeSiteId: S2, archived: false, sharedWith: [S3] },
  { id: required(F5), homeSiteId: S2, archived: false, sharedWith: [S3, S2] },
  {
    id: required(F6),
    homeSiteId: S3,
    archived: false,
    sharedWith: [],
    assignee: dave,
  },
  { id: required(F7), homeSiteId: null, archived: false, sharedWith: [S1] },
];

const sheetRows: readonly SheetRow[] = [
  { id: required(H1), folderId: required(F1), siteId: S2 },
  { id: required(H2), folderId: required(F5), siteId: null },
  { id: required(H3), folderId: required(F6), siteId: S2 },
  { id: required(H4), folderId: required(F4), siteId: S3 },
];

const siteGrants: readonly [string, string, SubjectRef][] = [
  [S1, "member", alice],
  [S2, "manager", bob],
  [S3, "auditor", carol],
  [S2, "blocked", carol],
  [S1, "archivist", frank],
  [S1, "member", gina],
  [S2, "blocked", gina],
];

function relationshipsFor(): readonly RelationshipWrite[] {
  const site = (siteId: string): SubjectRef => ({
    type: Site.wireName,
    id: siteId,
  });
  const writes: RelationshipWrite[] = siteGrants.map(([siteId, relation, subject]) =>
    relationshipWrite({ type: Site.wireName, id: siteId }, relation, subject),
  );
  for (const row of folderRows) {
    const resource = { type: Folder.wireName, id: row.id };
    if (row.homeSiteId !== null) {
      writes.push(relationshipWrite(resource, "home_site", site(row.homeSiteId)));
      if (row.sharedWith.length === 0) {
        writes.push(relationshipWrite(resource, "fallback_site", site(row.homeSiteId)));
      }
    }
    for (const sharedSite of row.sharedWith) {
      writes.push(relationshipWrite(resource, "shared_site", site(sharedSite)));
    }
    if (row.archived) {
      writes.push(
        relationshipWrite(resource, "archived", {
          type: Member.wireName,
          id: "*",
        }),
      );
    }
    if (row.assignee !== undefined) {
      writes.push(relationshipWrite(resource, "assignee", row.assignee));
    }
  }
  for (const row of sheetRows) {
    const resource = { type: Sheet.wireName, id: row.id };
    writes.push(
      relationshipWrite(resource, "folder", {
        type: Folder.wireName,
        id: row.folderId,
      }),
    );
    if (row.siteId !== null) {
      writes.push(relationshipWrite(resource, "site", site(row.siteId)));
    }
  }
  return writes;
}

async function insertRows(db: DrizzleHandle): Promise<void> {
  await db.insert(folders).values(
    folderRows.map((row) => ({
      id: row.id,
      homeSiteId: row.homeSiteId,
      archived: row.archived,
    })),
  );
  await db
    .insert(folderShares)
    .values(folderRows.flatMap((row) => row.sharedWith.map((siteId) => ({ folderId: row.id, siteId }))));
  await db.insert(sheets).values([...sheetRows]);
}

const SUBJECTS = [alice, bob, carol, dave, frank, gina, erin];

describe("proveScopeMatchesLookup (integration)", () => {
  let postgres: TestPostgres;
  let spiceDb: TestSpiceDb;
  let db: DrizzleHandle;
  let authorization: SpiceDbAuthorization;

  beforeAll(async () => {
    [postgres, spiceDb] = await Promise.all([startUnmigratedTestPostgres({ attributed: false }), startTestSpiceDb()]);
    db = drizzle(postgres.pool);
    await createFixtureTables(db);
    await insertRows(db);
    authorization = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
    await authorization.writeSchema(fixtureZed());
    await authorization.writeRelationships(relationshipsFor());
  }, 120_000);

  afterAll(async () => {
    await Promise.all([postgres.stop(), spiceDb.stop()]);
  });

  it("seeds a world where each subject sees a different set", async () => {
    const visibleTo = async (subject: SubjectRef, resourceType: string) =>
      [
        ...(await authorization.lookupResources({
          subject,
          permission: "view",
          resourceType,
        })),
      ].sort();
    const sorted = (ids: readonly (string | undefined)[]) => ids.map(required).sort();

    expect(await visibleTo(alice, Folder.wireName)).toEqual(sorted([F1, F2, F3, F7]));
    expect(await visibleTo(bob, Folder.wireName)).toEqual(sorted([F2, F4, F5]));
    expect(await visibleTo(carol, Folder.wireName)).toEqual(sorted([F4]));
    expect(await visibleTo(dave, Folder.wireName)).toEqual(sorted([F6]));
    expect(await visibleTo(frank, Folder.wireName)).toEqual(sorted([F3]));
    expect(await visibleTo(erin, Folder.wireName)).toEqual([]);

    expect(await visibleTo(alice, Sheet.wireName)).toEqual(sorted([H1]));
    expect(await visibleTo(bob, Sheet.wireName)).toEqual(sorted([H1, H2, H3, H4]));
    expect(await visibleTo(carol, Sheet.wireName)).toEqual(sorted([H4]));
    expect(await visibleTo(dave, Sheet.wireName)).toEqual(sorted([H3]));
    expect(await visibleTo(gina, Sheet.wireName)).toEqual([]);
  });

  it("proves the folder scope matches lookupResources for every subject", async () => {
    await proveScopeMatchesLookup({
      model: fixtureAccess,
      relatedSqlBindings: [folderSql],
      db,
      authorization,
      wireName: Folder.wireName,
      permission: "view",
      sqlBindings: folderSql,
      subjects: SUBJECTS,
    });
  });

  it("proves the sheet scope, walking into the folder, matches lookupResources", async () => {
    await proveScopeMatchesLookup({
      model: fixtureAccess,
      relatedSqlBindings: [folderSql],
      db,
      authorization,
      wireName: Sheet.wireName,
      permission: "view",
      sqlBindings: sheetSql,
      subjects: SUBJECTS,
    });
  });

  it("fails with a readable diff when one SQL binding is wrong", async () => {
    // The derived role forgets "while shared nowhere", so an archived folder
    // that IS shared leaks into the archivist's SQL scope.
    const wrongFolderSql = scopeSqlBindings(folderScope, {
      table: folders,
      id: folders.id,
      roles: {
        ...folderSqlRoles,
        fallback_site: {
          kind: "derived",
          matches: (ids) => sql`${folders.homeSiteId} = ANY(${ids})`,
        },
      },
    });
    try {
      await expect(
        proveScopeMatchesLookup({
          model: fixtureAccess,
          relatedSqlBindings: [folderSql],
          db,
          authorization,
          wireName: Folder.wireName,
          permission: "view",
          sqlBindings: wrongFolderSql,
          subjects: SUBJECTS,
        }),
      ).rejects.toThrow(
        [
          "scope filter for listfixture/folder.view disagrees with lookupResources",
          "  plan: any(lookup(home_site: listfixture/site#view_records), lookup(shared_site: listfixture/site#view_records), all(lookup(fallback_site: listfixture/site#archive_records), tag(archived)), all(lookup(shared_site: listfixture/site#audit_records), not(lookup(shared_site: listfixture/site#blocked_here))), direct(assignee))",
          "  listfixture/member:frank",
          `    SQL reads, SpiceDB denies: ${required(F2)}`,
        ].join("\n"),
      );
    } finally {
      // Put the right bindings back for any walk into the folder.
      scopeSqlBindings(folderScope, {
        table: folders,
        id: folders.id,
        roles: folderSqlRoles,
      });
    }
  });
});
