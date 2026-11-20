import { access, entityHandle } from "@dads-framework/access";
import { fromFixed, getRoute, routeGroup } from "@dads-framework/http";
import { definePlugin } from "@dads-framework/plugin";
import { z } from "zod";

import { userEntity } from "../notes-access.js";
import { notesData } from "../notes-data.js";

export const staffDashboard = entityHandle({
  wireName: "notes/staff_dashboard",
  idSchema: z.literal("notes"),
});

export const staffNotesAccess = access(staffDashboard, {
  roles: { operator: userEntity },
  permissions: ({ operator }) => ({ inspect: [operator] }),
});

const inspect = staffNotesAccess.permissions.inspect;

export const staffNotes = definePlugin({
  name: "staff-notes",
  requires: [notesData],
  contributes: { access: [staffNotesAccess] },
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
