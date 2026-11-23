import { randomUUID } from "node:crypto";
import { paginationQuerySchema } from "@dads-framework/core/contract";
import { getRoute, listRoute, postRoute, routeGroup } from "@dads-framework/http";
import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { notesAccess, notesPermission } from "../access/index.js";
import { inTenant, note, noteFeatures, noteInput } from "../contract/index.js";
import { createNotesStore } from "./notes-store.js";

export function notesRoutes({
  db,
  flags,
  writeWithPermission,
}: Pick<StarterServices, "db" | "flags" | "writeWithPermission">) {
  const notesStore = createNotesStore(db);

  return routeGroup("Notes", [
    getRoute({
      route: { method: "GET", template: "/tenants/:tenantId/notes/features" },
      summary: "Read feature availability for a tenant",
      access: notesAccess,
      params: inTenant,
      response: noteFeatures,
      handler: ({ params }) => flags.execute({ kind: "tenant", tenantId: params.tenantId }),
    }),
    listRoute({
      route: { method: "GET", template: "/tenants/:tenantId/notes" },
      summary: "Read notes in a tenant",
      access: notesAccess,
      params: inTenant,
      item: note,
      query: paginationQuerySchema,
      handler: ({ params, query }) =>
        notesStore.listNotes({
          tenantId: params.tenantId,
          page: query.page,
          perPage: query.perPage,
        }),
    }),
    postRoute({
      route: { method: "POST", template: "/tenants/:tenantId/notes" },
      summary: "Create a note in a tenant",
      access: notesAccess,
      params: inTenant,
      body: noteInput,
      response: note,
      handler: ({ body, params, subject }) => {
        const value = {
          id: randomUUID(),
          tenantId: params.tenantId,
          text: body.text,
        };
        return writeWithPermission({ subject, permission: notesPermission, resourceId: params.tenantId }, (tx) =>
          notesStore.insertNote(tx, value),
        );
      },
    }),
  ]);
}
