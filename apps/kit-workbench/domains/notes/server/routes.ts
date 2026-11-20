import { randomUUID } from "node:crypto";
import { paginationQuerySchema } from "@dads-framework/contract";
import {
  getRoute,
  listRoute,
  postRoute,
  routeGroup,
} from "@dads-framework/http";
import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { tenantIdSchema } from "@dads-framework/tenants";
import { count, eq } from "drizzle-orm";
import { notesAccess, notesPermission } from "../access/index.js";
import { inTenant, note, noteFeatures, noteInput } from "../contract/index.js";
import { noteTable } from "./tables.js";

export function notesRoutes({
  db,
  flags,
  writeWithPermission,
}: Pick<StarterServices, "db" | "flags" | "writeWithPermission">) {
  return routeGroup("Notes", [
    getRoute({
      route: { method: "GET", template: "/tenants/:tenantId/notes/features" },
      summary: "Read feature availability for a tenant",
      access: notesAccess,
      params: inTenant,
      response: noteFeatures,
      handler: ({ params }) =>
        flags.execute({ kind: "tenant", tenantId: params.tenantId }),
    }),
    listRoute({
      route: { method: "GET", template: "/tenants/:tenantId/notes" },
      summary: "Read notes in a tenant",
      access: notesAccess,
      params: inTenant,
      item: note,
      query: paginationQuerySchema,
      handler: async ({ params, query }) => {
        const scope = eq(noteTable.tenantId, params.tenantId);
        const [rows, totals] = await Promise.all([
          db
            .select()
            .from(noteTable)
            .where(scope)
            .orderBy(noteTable.id)
            .limit(query.perPage)
            .offset((query.page - 1) * query.perPage),
          db.select({ total: count() }).from(noteTable).where(scope),
        ]);
        return {
          items: rows.map((row) => ({
            id: row.id,
            text: row.text,
            tenantId: tenantIdSchema.parse(row.tenantId),
          })),
          total: totals[0]?.total ?? 0,
        };
      },
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
        return writeWithPermission(
          { subject, permission: notesPermission, resourceId: params.tenantId },
          async (tx) => {
            await tx.insert(noteTable).values(value);
            return value;
          },
        );
      },
    }),
  ]);
}
