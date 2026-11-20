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

import {
  access,
  accessModel,
  emitAccessIr,
  emitZedForDefinitions,
  entityHandle,
  excluding,
  gated,
  scopeBindings,
  through,
  wildcard,
} from "@dads-framework/access";
import type { DrizzleHandle } from "@dads-framework/postgres";

import { scopeSqlBindings, type ScopeSqlRoles } from "../scope-sql-bindings.js";

const idSchema = z.string();

// ─── Access rules ────────────────────────────────────────────────────────────

export const Member = entityHandle({
  wireName: "listfixture/member",
  idSchema,
});

export const Site = entityHandle({
  wireName: "listfixture/site",
  idSchema,
  kind: "scope",
});

export const Folder = entityHandle({
  wireName: "listfixture/folder",
  idSchema,
  kind: "record",
});

export const Sheet = entityHandle({
  wireName: "listfixture/sheet",
  idSchema,
  kind: "record",
});

export const site = access(Site, {
  roles: {
    member: Member,
    manager: Member,
    auditor: Member,
    archivist: Member,
    blocked: Member,
  },
  permissions: (roles) => ({
    view_records: [roles.member, roles.manager],
    manage_records: [roles.manager],
    audit_records: [roles.auditor],
    archive_records: [roles.archivist],
    blocked_here: [roles.blocked],
  }),
});

export const folder = access(Folder, {
  roles: {
    home_site: Site,
    shared_site: Site,
    // The home site while the folder is shared nowhere.
    fallback_site: Site,
    archived: wildcard(Member),
    assignee: Member,
  },
  permissions: (roles) => ({
    view: [
      through(roles.home_site, site.permissions.view_records),
      through(roles.shared_site, site.permissions.view_records),
      gated(
        through(roles.fallback_site, site.permissions.archive_records),
        roles.archived,
      ),
      excluding(
        through(roles.shared_site, site.permissions.audit_records),
        through(roles.shared_site, site.permissions.blocked_here),
      ),
      roles.assignee,
    ],
  }),
});

export const sheet = access(Sheet, {
  roles: { folder: Folder, site: Site },
  permissions: (roles) => ({
    view: [
      excluding(
        through(roles.folder, folder.permissions.view),
        through(roles.site, site.permissions.blocked_here),
      ),
      through(roles.site, site.permissions.manage_records),
    ],
  }),
});

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

export const fixtureAccess = accessModel(
  [site, folder, sheet],
  [folderScope, sheetScope],
);

/** The SpiceDB schema for the fixture's definitions alone. */
export function fixtureZed(): string {
  return `definition ${Member.wireName} {}\n\n${emitZedForDefinitions(emitAccessIr(fixtureAccess))}`;
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
    matches: (ids: SQL) =>
      sql`${folders.homeSiteId} = ANY(${ids}) AND ${sharedNowhere}`,
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
