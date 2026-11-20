import {
  getFromApi,
  getPageFromApi,
} from "@dads-framework/client-request-transport";
import { paginationQuerySchema } from "@dads-framework/contract";
import type { z } from "zod";
import {
  memberPermissions,
  memberPermissionsRoute,
  permissionMember,
  permissionRosterRoute,
} from "../contract/permissions-wire.js";

const headers = { "Cache-Control": "no-cache, no-store" };

export async function readPermissionRoster(
  tenantId: string,
  signal: AbortSignal,
) {
  const members: z.output<typeof permissionMember>[] = [];
  for (let page = 1; ; page += 1) {
    const { items, meta } = await getPageFromApi({
      route: permissionRosterRoute.bind(tenantId),
      returns: permissionMember,
      query: { schema: paginationQuerySchema, value: { page, perPage: 50 } },
      headers,
      signal,
    });
    members.push(...items);
    if (items.length === 0 || meta.page * meta.perPage >= meta.total)
      return { members };
  }
}

export function readMemberPermissions(
  tenantId: string,
  accountId: string,
  signal: AbortSignal,
) {
  return getFromApi({
    route: memberPermissionsRoute.bind(tenantId, accountId),
    returns: memberPermissions,
    headers,
    signal,
  });
}
