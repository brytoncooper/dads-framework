/**
 * A tiny world for proving the scoped-list seam: one scope (`site`), two
 * records (`folder`, and `sheet`, which walks into its folder). Between them
 * the `view` rules reach every plan operator — a scope column, a child-table
 * join, a derived role, a tag, a sparse direct grant, any, all, not, and via.
 *
 * The tables are throwaway: `createFixtureTables` makes them in a private test
 * database; they are not part of any migration.
 */
import { sql, type SQL } from "drizzle-orm";
import { boolean, pgTable, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";

import { actor, allOf, compileAccess, emitAccessIr, emitZedForDefinitions, resource } from "@dads-framework/access";
import { scopeBindings } from "@dads-framework/access/scopes";
import type { DrizzleHandle } from "@dads-framework/postgres";

import { scopeSqlBindings, type ScopeSqlRoles } from "../scope-sql-bindings.js";

const idSchema = z.string();

// ─── Access rules ────────────────────────────────────────────────────────────

export const Member = actor("listfixture/member", { id: idSchema });

export const site = resource("listfixture/site", {
  id: idSchema,
  roles: {
    member: Member,
    manager: Member,
    auditor: Member,
    archivist: Member,
    blocked: Member,
  },
  can: ({ member, manager, auditor, archivist, blocked }) => ({
    view_records: [member, manager],
    manage_records: manager,
    audit_records: auditor,
    archive_records: archivist,
    blocked_here: blocked,
  }),
});

export const Site = site;

export const folder = resource("listfixture/folder", {
  id: idSchema,
  roles: {
    home_site: site,
    shared_site: site,
    // The home site while the folder is shared nowhere.
    fallback_site: site,
    archived: Member.anyone,
    assignee: Member,
  },
  can: ({ home_site, shared_site, fallback_site, archived, assignee }) => ({
    view: [
      home_site.view_records,
      shared_site.view_records,
      allOf(fallback_site.archive_records, archived),
      shared_site.audit_records.unless(shared_site.blocked_here),
      assignee,
    ],
  }),
});

export const Folder = folder;

export const sheet = resource("listfixture/sheet", {
  id: idSchema,
  roles: { folder, site },
  can: ({ folder: parentFolder, site: parentSite }) => ({
    view: [parentFolder.view.unless(parentSite.blocked_here), parentSite.manage_records],
  }),
});

export const Sheet = sheet;

export const folderScope = scopeBindings(folder, {
  home_site: { kind: "scope-column" },
  shared_site: { kind: "scope-join" },
  fallback_site: { kind: "derived" },
  archived: { kind: "tag" },
  assignee: { kind: "sparse-direct" },
});

export const sheetScope = scopeBindings(sheet, {
  folder: { kind: "scope-column" },
  site: { kind: "scope-column" },
});

export const fixtureAccess = compileAccess([Member, site, folder, sheet], {
  bindings: [folderScope, sheetScope],
  allowLookupResourcesOn: [site],
});

/** The SpiceDB schema for the fixture's definitions alone. */
export function fixtureZed(): string {
  return emitZedForDefinitions(emitAccessIr(fixtureAccess));
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export const folders = pgTable("scoped_list_folders", {
  id: uuid("id").primaryKey(),
  homeSiteId: uuid("home_site_id"),
  archived: boolean("archived").notNull(),
});

export const folderShares = pgTable("scoped_list_folder_shares", {
  folderId: uuid("folder_id").notNull(),
  siteId: uuid("site_id").notNull(),
});

export const sheets = pgTable("scoped_list_sheets", {
  id: uuid("id").primaryKey(),
  folderId: uuid("folder_id").notNull(),
  siteId: uuid("site_id"),
});

export async function createFixtureTables(db: DrizzleHandle): Promise<void> {
  await db.execute(sql`
    CREATE TABLE scoped_list_folders (
      id uuid PRIMARY KEY,
      home_site_id uuid,
      archived boolean NOT NULL
    );
    CREATE TABLE scoped_list_folder_shares (
      folder_id uuid NOT NULL REFERENCES scoped_list_folders (id),
      site_id uuid NOT NULL
    );
    CREATE TABLE scoped_list_sheets (
      id uuid PRIMARY KEY,
      folder_id uuid NOT NULL REFERENCES scoped_list_folders (id),
      site_id uuid
    );
  `);
}

// ─── SQL bindings ────────────────────────────────────────────────────────────

function sharedWithAny(ids: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${folderShares} WHERE ${folderShares.folderId} = ${folders.id} AND ${folderShares.siteId} = ANY(${ids}))`;
}

const sharedNowhere = sql`NOT EXISTS (SELECT 1 FROM ${folderShares} WHERE ${folderShares.folderId} = ${folders.id})`;

export const folderSqlRoles = {
  home_site: { kind: "scope-column", column: folders.homeSiteId },
  shared_site: { kind: "scope-join", matches: sharedWithAny },
  fallback_site: {
    kind: "derived",
    matches: (ids: SQL) => sql`${folders.homeSiteId} = ANY(${ids}) AND ${sharedNowhere}`,
  },
  archived: { kind: "tag", condition: sql`${folders.archived}` },
} satisfies ScopeSqlRoles<typeof folderScope.roles>;

export const folderSql = scopeSqlBindings(folderScope, {
  table: folders,
  id: folders.id,
  roles: folderSqlRoles,
});

export const sheetSql = scopeSqlBindings(sheetScope, {
  table: sheets,
  id: sheets.id,
  roles: {
    folder: { kind: "scope-column", column: sheets.folderId },
    site: { kind: "scope-column", column: sheets.siteId },
  },
});
