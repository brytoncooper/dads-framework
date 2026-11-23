/**
 * A small fake schema for the scope-plan compiler: one lookup-allowlisted
 * scope (`site`) and two bound records (`folder`, `sheet`, where a sheet
 * reaches its folder). Between them the rules use every operator, a sibling
 * permission, a repeated lookup, a tag gate, a sparse direct grant, and a
 * cross-record walk.
 */
import { actor, allOf, anyOf, permissionToken, resource } from "../../index.js";

export const member = actor("test/member");

export const site = resource("test/site", {
  roles: { member, manager: member, blocked: member },
  can: ({ member: siteMember, manager, blocked }) => ({
    view_records: [siteMember, manager],
    manage_records: manager,
    blocked_here: blocked,
  }),
});

export const folder = resource("test/folder", {
  roles: {
    home_site: site,
    shared_site: site,
    draft_site: site,
    archived: member.anyone,
    assignee: member,
    reader: member,
    unbound_site: site,
  },
  can: ({ home_site, shared_site, draft_site, archived, assignee, reader, unbound_site }) => ({
    view_on_site: [home_site.view_records, shared_site.view_records],
    view: anyOf(
      permissionToken("test/folder", "view_on_site"),
      // Repeats the first arm of view_on_site; the plan asks it once.
      home_site.view_records,
      allOf(draft_site.view_records, archived),
      shared_site.manage_records.unless(shared_site.blocked_here),
      allOf(home_site.manage_records, draft_site.manage_records),
      assignee,
    ),
    manage_on_home_site: home_site.manage_records,
    read_directly: reader,
    view_unbound: unbound_site.view_records,
  }),
});

export const sheet = resource("test/sheet", {
  roles: { folder, site },
  can: ({ folder: sheetFolder, site: sheetSite }) => ({
    view: allOf(sheetFolder.view_on_site, sheetSite.view_records),
    view_or_manage_folder: [sheetFolder.view_on_site, sheetFolder.manage_on_home_site],
  }),
});
