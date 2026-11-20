/**
 * A small fake schema for the scope-plan compiler: one scope (`site`) and two
 * records (`folder`, `sheet`, where a sheet reaches its folder). Between them
 * the rules use every operator, a sibling permission, a repeated lookup, a tag
 * gate, a sparse direct grant, and a cross-record walk.
 */
import { z } from "zod";
import { both, excluding, gated, through } from "../combinators.js";
import { entityHandle } from "../entity-handle.js";
import { wildcard } from "../holders.js";
import { access } from "../model.js";
import { permissionToken } from "../refs.js";

const idSchema = z.string();

export const Member = entityHandle({ wireName: "test/member", idSchema });

export const Site = entityHandle({
  wireName: "test/site",
  idSchema,
  kind: "scope",
});

export const Folder = entityHandle({
  wireName: "test/folder",
  idSchema,
  kind: "record",
});

export const Sheet = entityHandle({
  wireName: "test/sheet",
  idSchema,
  kind: "record",
});

export const site = access(Site, {
  roles: { member: Member, manager: Member, blocked: Member },
  permissions: (roles) => ({
    view_records: [roles.member, roles.manager],
    manage_records: [roles.manager],
    blocked_here: [roles.blocked],
  }),
});

export const folder = access(Folder, {
  roles: {
    home_site: Site,
    shared_site: Site,
    draft_site: Site,
    archived: wildcard(Member),
    assignee: Member,
    reader: Member,
    unbound_site: Site,
  },
  permissions: (roles) => ({
    view_on_site: [
      through(roles.home_site, site.permissions.view_records),
      through(roles.shared_site, site.permissions.view_records),
    ],
    view: [
      permissionToken(Folder.wireName, "view_on_site"),
      // Repeats the first arm of view_on_site; the plan asks it once.
      through(roles.home_site, site.permissions.view_records),
      gated(
        through(roles.draft_site, site.permissions.view_records),
        roles.archived,
      ),
      excluding(
        through(roles.shared_site, site.permissions.manage_records),
        through(roles.shared_site, site.permissions.blocked_here),
      ),
      both(
        through(roles.home_site, site.permissions.manage_records),
        through(roles.draft_site, site.permissions.manage_records),
      ),
      roles.assignee,
    ],
    manage_on_home_site: [
      through(roles.home_site, site.permissions.manage_records),
    ],
    read_directly: [roles.reader],
    view_unbound: [through(roles.unbound_site, site.permissions.view_records)],
  }),
});

export const sheet = access(Sheet, {
  roles: { folder: Folder, site: Site },
  permissions: (roles) => ({
    view: [
      gated(
        through(roles.folder, folder.permissions.view_on_site),
        through(roles.site, site.permissions.view_records),
      ),
    ],
    view_or_manage_folder: [
      through(roles.folder, folder.permissions.view_on_site),
      through(roles.folder, folder.permissions.manage_on_home_site),
    ],
  }),
});
