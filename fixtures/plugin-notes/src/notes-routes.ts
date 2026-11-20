import {
  fromParam,
  getRoute,
  type HttpRoute,
  routeGroup,
} from "@dads-framework/http";
import { z } from "zod";

import { noteAccess } from "./notes-access.js";
import type { NotesStore } from "./notes-store.js";

const noteResponse = z.object({ id: z.string(), text: z.string() });
const viewNote = noteAccess.permissions.view;

/** `GET /notes/:id`, for a caller who may view that note. */
export function notesRoutes(store: Pick<NotesStore, "find">): HttpRoute[] {
  return routeGroup("Notes", [
    getRoute({
      route: { method: "GET", template: "/notes/:id" },
      summary: "Read one note",
      access: {
        kind: "permission",
        resourceType: viewNote.entityWireName,
        permission: viewNote.permissionName,
        resourceId: fromParam("id"),
      },
      params: z.object({ id: z.string() }),
      response: noteResponse,
      handler: ({ params }) => {
        const note = store.find(params.id);
        return { id: params.id, text: note?.text ?? "" };
      },
    }),
  ]);
}
