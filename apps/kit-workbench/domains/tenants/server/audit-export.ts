import {
  createAuditLogExporter,
  DrizzleAuditLogReader,
  type AuditLogCursor,
} from "@dads-framework/audit";
import { notFound, validation } from "@dads-framework/core/errors";
import {
  defineRawRoute,
  fromParam,
  requires,
  routeGroup,
} from "@dads-framework/http";
import { definePlugin } from "@dads-framework/core/plugin";
import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { z } from "zod";

import {
  starterServices,
  tenantAccess,
  type StarterServices,
} from "../../../libraries/app-runtime/index.js";
import { auditExportCopy } from "../copy/audit-export-openapi.js";

const tenantParams = z.strictObject({ tenantId: tenantIdSchema });
const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number);
const pageSize = positiveInteger.pipe(z.int().max(500)).default(100);
const querySchema = z.union([
  z.strictObject({ pageSize }),
  z.strictObject({
    pageSize,
    beforeRecordedAt: z.iso.datetime({ precision: 6 }),
    beforePosition: positiveInteger.pipe(z.int()),
  }),
]);
const auditExportPath = "/tenants/:tenantId/audit-log/export";
const nextLinkRelation = 'rel="next"';
const permission = tenantAccess.tenant.permissions.manage_tenant;

export const tenantAuditExportPlugin = definePlugin({
  name: "tenant-audit-export",
  requires: [starterServices],
  setup: ({ use }) => ({
    routes: tenantAuditExportRoutes(use(starterServices)),
  }),
});

function tenantAuditExportRoutes({
  db,
  authorization,
}: Pick<StarterServices, "db" | "authorization">) {
  const reader = new DrizzleAuditLogReader(db);
  return routeGroup(auditExportCopy["tenants.auditExport.tag"].en, [
    defineRawRoute({
      method: "GET",
      path: auditExportPath,
      summary: auditExportCopy["tenants.auditExport.summary"].en,
      access: requires(permission, fromParam("tenantId")),
      openapi: {
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "pageSize",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
          {
            name: "beforeRecordedAt",
            in: "query",
            schema: { type: "string", format: "date-time" },
            description:
              auditExportCopy["tenants.auditExport.beforeRecordedAt"].en,
          },
          {
            name: "beforePosition",
            in: "query",
            schema: { type: "integer", minimum: 1 },
            description:
              auditExportCopy["tenants.auditExport.beforePosition"].en,
          },
        ],
        responses: {
          "200": {
            description: auditExportCopy["tenants.auditExport.success"].en,
            headers: {
              Link: {
                description:
                  auditExportCopy["tenants.auditExport.continuation"].en,
                schema: { type: "string" },
              },
            },
            content: { "application/x-ndjson": { schema: { type: "string" } } },
          },
          "400": {
            description: auditExportCopy["tenants.auditExport.invalidInput"].en,
          },
          "401": {
            description:
              auditExportCopy["tenants.auditExport.authenticationRequired"].en,
          },
          "404": {
            description:
              auditExportCopy["tenants.auditExport.tenantUnavailable"].en,
          },
        },
      },
      handler: async ({ request, reply, subject, authenticatedSubject }) => {
        const params = tenantParams.safeParse(request.params);
        const query = querySchema.safeParse(request.query);
        if (!params.success || !query.success)
          throw validation(
            "INVALID_AUDIT_EXPORT",
            "Supply a tenant and a valid export page.",
          );
        const { tenantId } = params.data;
        const exportPage = createAuditLogExporter({
          reader,
          tenantDimension: "tenant_id",
          authorize: (id) => {
            if (
              subject === null ||
              authenticatedSubject === null ||
              subject.type !== authenticatedSubject.type ||
              subject.id !== authenticatedSubject.id
            )
              return false;
            return authorization.check({
              subject: authenticatedSubject,
              resource: { type: permission.entityWireName, id },
              permission: permission.permissionName,
            });
          },
        });
        const input = query.data;
        const page = await exportPage({
          tenantId,
          pageSize: input.pageSize,
          ...("beforePosition" in input
            ? {
                olderThan: {
                  position: input.beforePosition,
                  recordedAt: input.beforeRecordedAt,
                },
              }
            : {}),
        });
        if (page.kind === "denied")
          throw notFound("RESOURCE_NOT_FOUND", "Resource not found");
        if (page.nextCursor !== null)
          void reply.header(
            "link",
            nextPageLink(tenantId, input.pageSize, page.nextCursor),
          );
        await reply
          .header("cache-control", "no-store")
          .header(
            "content-disposition",
            'attachment; filename="audit-log.ndjson"',
          )
          .type(page.contentType)
          .send(page.body);
      },
    }),
  ]);
}

function nextPageLink(
  tenantId: string,
  pageSize: number,
  next: AuditLogCursor,
): string {
  const query = new URLSearchParams({
    pageSize: String(pageSize),
    beforePosition: String(next.position),
    beforeRecordedAt: next.recordedAt,
  });
  const tenantPath = auditExportPath.replace(
    ":tenantId",
    encodeURIComponent(tenantId),
  );
  const nextUrl = `/api${tenantPath}?${query}`;
  return `<${nextUrl}>; ${nextLinkRelation}`;
}
