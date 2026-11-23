import { resource, type DslNode } from "@dads-framework/access";
import { fromFixed, getRoute, routeGroup } from "@dads-framework/http";
import { definePlugin } from "@dads-framework/core/plugin";
import { z } from "zod";

import { userAccess } from "../notes-access.js";
import { notesData } from "../notes-data.js";

export const staffNotesAccess = resource("notes/staff_dashboard", {
  id: z.literal("notes"),
  roles: { operator: userAccess },
  can: ({ operator }) => ({ inspect: operator }),
});

export const staffDashboard = staffNotesAccess.handle;

const inspect = staffNotesAccess.permissions.inspect;
const staffAccess: readonly DslNode[] = [staffNotesAccess];

export const staffNotes = definePlugin({
  name: "staff-notes",
  requires: [notesData],
  contributes: { access: staffAccess },
  setup: ({ use }) => {
    const notes = use(notesData);
    return {
      routes: routeGroup("Staff notes", [
        getRoute({
          route: { method: "GET", template: "/staff/notes/count" },
          summary: "Count notes for a staff operator",
          access: {
            kind: "permission",
            resourceType: inspect.entityWireName,
            permission: inspect.permissionName,
            resourceId: fromFixed("notes"),
          },
          response: z.object({ count: z.number().int().nonnegative() }),
          handler: () => ({ count: notes.count() }),
        }),
      ]),
    };
  },
});
