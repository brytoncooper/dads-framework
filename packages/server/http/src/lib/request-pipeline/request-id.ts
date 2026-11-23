import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { opaqueIdSchema, REQUEST_ID_HEADER } from "@dads-framework/core/contract";

/**
 * Correlation ingress (docs/architecture/observability.md): trust a sane
 * inbound X-Request-Id (trimmed, capped) or mint one. Owned by this library —
 * no middleware exists; this runs inside createHttpApp for every request.
 */

/**
 * `request_log`'s primary key. Opaque rather than `entityIdSchema`: a trusted
 * inbound `X-Request-Id` is trimmed and capped, never format-checked, so a
 * caller's non-UUID value must still parse.
 */
export const requestIdSchema = opaqueIdSchema("RequestId", "HTTP request correlation id");

export type RequestId = z.infer<typeof requestIdSchema>;
export function resolveRequestId(header: unknown): {
  id: string;
  generated: boolean;
} {
  if (typeof header === "string" && header.trim().length > 0) {
    return { id: header.trim().slice(0, 128), generated: false };
  }
  return { id: randomUUID(), generated: true };
}

export function requestIdOf(request: { readonly headers: Record<string, unknown>; readonly id: string }): string {
  const header = request.headers[REQUEST_ID_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  return request.id;
}
