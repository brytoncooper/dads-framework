import { z } from "zod";

import { parseAuditLogPosition } from "../database/audit-log-position.ids.js";
import type { AuditLogCursor, AuditLogReader, AuditLogRecord } from "../database/readers/audit-log-reader.interface.js";

const exportRequest = z.strictObject({
  tenantId: z.string().min(1).max(255),
  pageSize: z.int().min(1).max(500).default(100),
  olderThan: z
    .strictObject({
      recordedAt: z.iso.datetime({ precision: 6 }),
      position: z
        .int()
        .positive()
        .transform((value, context) => {
          const position = parseAuditLogPosition(value);
          if (position !== null) return position;
          context.addIssue({
            code: "custom",
            message: "Invalid audit log position",
          });
          return z.NEVER;
        }),
    })
    .optional(),
});

export type AuditLogExportOptions = {
  readonly reader: Pick<AuditLogReader, "listRows">;
  /** The tenant dimension configured on the audited tables. */
  readonly tenantDimension: string;
  /** Check the authenticated caller's permission to export this tenant. */
  readonly authorize: (tenantId: string) => boolean | Promise<boolean>;
};

export type AuditLogExportPage =
  | { readonly kind: "denied" }
  | {
      readonly kind: "page";
      readonly contentType: "application/x-ndjson";
      readonly body: string;
      readonly nextCursor: AuditLogCursor | null;
    };

/** Read one authorized tenant page and serialize audit metadata as NDJSON. */
export function createAuditLogExporter({
  reader,
  tenantDimension,
  authorize,
}: AuditLogExportOptions): (input: unknown) => Promise<AuditLogExportPage> {
  const dimension = z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/u)
    .parse(tenantDimension);

  return async (input) => {
    const { tenantId, pageSize, olderThan } = exportRequest.parse(input);
    const grant: unknown = await authorize(tenantId);
    if (grant !== true) return { kind: "denied" };

    const rows = await reader.listRows(
      { kind: "application", values: { [dimension]: tenantId } },
      {},
      olderThan ?? null,
      pageSize + 1,
    );
    const page = rows.slice(0, pageSize);
    return {
      kind: "page",
      contentType: "application/x-ndjson",
      body: page.map(serializeAuditMetadata).join(""),
      nextCursor: rows.length > pageSize ? (page.at(-1)?.cursor ?? null) : null,
    };
  };
}

function serializeAuditMetadata(row: AuditLogRecord): string {
  return `${JSON.stringify({
    position: row.position,
    recordedAt: row.cursor.recordedAt,
    actorKind: row.actorKind,
    actorId: row.actorId,
    userId: row.userId,
    requestId: row.requestId,
    tableName: row.tableName,
    operation: row.operation,
    changedColumns: row.changedColumns,
  })}\n`;
}
