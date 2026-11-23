import { randomUUID } from "node:crypto";
import { getRoute, listRoute, postRoute, routeGroup } from "@dads-framework/http";
import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { notesAccess, notesPermission } from "../access/index.js";
import { createNoteOp, listNotesOp, readNoteFeaturesOp } from "../contract/index.js";
import { createNoteRecord } from "../pure/note-rules.js";
import { createNotesStore } from "./notes-store.js";

export function notesRoutes({
  db,
  flags,
  writeWithPermission,
}: Pick<StarterServices, "db" | "flags" | "writeWithPermission">) {
  const notesStore = createNotesStore(db);

  return routeGroup("Notes", [
    getRoute({
      operation: readNoteFeaturesOp,
      summary: "Read feature availability for a tenant",
      access: notesAccess,
      handler: ({ params }) => flags.execute({ kind: "tenant", tenantId: params.tenantId }),
    }),
    listRoute({
      operation: listNotesOp,
      summary: "Read notes in a tenant",
      access: notesAccess,
      handler: ({ params, query }) =>
        notesStore.listNotes({
          tenantId: params.tenantId,
          page: query.page,
          perPage: query.perPage,
        }),
    }),
    postRoute({
      operation: createNoteOp,
      summary: "Create a note in a tenant",
      access: notesAccess,
      handler: ({ body, params, subject }) => {
        const value = createNoteRecord({
          id: randomUUID(),
          tenantId: params.tenantId,
          text: body.text,
        });
        return writeWithPermission({ subject, permission: notesPermission, resourceId: params.tenantId }, (tx) =>
          notesStore.insertNote(tx, value),
        );
      },
    }),
  ]);
}
