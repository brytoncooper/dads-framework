import { actor, resource } from "@dads-framework/access";
import {
  expectedRowVersionFields,
  rowVersionSchema,
} from "@dads-framework/core/contract";
import { staleSave } from "@dads-framework/core/errors";
import { fromParam, patchRoute, routeGroup } from "@dads-framework/http";
import {
  updateAtRowVersion,
  type DrizzleHandle,
} from "@dads-framework/postgres";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";

const idSchema = z.string().min(1);
export const editor = actor("editor", { id: idSchema });
export const noteAccess = resource("stale_save_note", {
  id: idSchema,
  roles: { editor },
  can: ({ editor: noteEditor }) => ({ edit: noteEditor }),
});

export const notes = pgTable("stale_save_notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  rowVersion: integer("row_version").notNull().default(1),
});

const bodySchema = z.strictObject({
  title: z.string().min(1),
  ...expectedRowVersionFields,
});
const responseSchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  rowVersion: rowVersionSchema,
});

export function noteRoutes(db: DrizzleHandle) {
  return routeGroup("Notes", [
    patchRoute({
      route: { method: "PATCH", template: "/notes/:id" },
      summary: "Update an authorized note",
      access: {
        kind: "permission",
        resourceType: noteAccess.permissions.edit.entityWireName,
        permission: noteAccess.permissions.edit.permissionName,
        resourceId: fromParam("id"),
      },
      params: z.strictObject({ id: idSchema }),
      body: bodySchema,
      response: responseSchema,
      handler: ({ params, body }) =>
        db.transaction(async (tx) => {
          const [saved] = await updateAtRowVersion(tx, notes, {
            where: eq(notes.id, params.id),
            expectedRowVersion: body.expectedRowVersion,
            changes: { title: body.title },
          });
          if (saved === undefined) throw staleSave();
          return {
            id: params.id,
            title: body.title,
            rowVersion: saved.rowVersion,
          };
        }),
    }),
  ]);
}
