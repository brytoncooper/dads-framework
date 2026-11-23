import { paginationQuerySchema } from "@dads-framework/core/contract";
import { notFound } from "@dads-framework/core/errors";
import {
  fromParam,
  getRoute,
  listRoute,
  requires,
  routeGroup,
} from "@dads-framework/http";
import {
  TenantUnavailableError,
  tenantIdSchema,
  type Tenants,
} from "@dads-framework/identity/tenants";
import { z } from "zod";
import { tenantAccess } from "../../../libraries/app-runtime/index.js";
import {
  memberPermissions,
  memberPermissionsRoute,
  permissionAccountId,
  permissionMember,
  permissionRosterRoute,
} from "../contract/permissions-wire.js";

const tenantParams = z.strictObject({ tenantId: tenantIdSchema });
const memberParams = tenantParams.extend({ accountId: permissionAccountId });
const access = requires(
  tenantAccess.tenant.permissions.manage_members,
  fromParam("tenantId"),
);

export function tenantPermissionRoutes(tenants: Tenants) {
  return routeGroup("Tenant permissions", [
    listRoute({
      route: permissionRosterRoute,
      summary: "List accounts with membership in this tenant",
      access,
      params: tenantParams,
      query: paginationQuerySchema,
      item: permissionMember,
      handler: async ({ params, query, subject }) => {
        const roster = await tenantRead(() =>
          tenants.memberships.roster(subject.id, params.tenantId),
        );
        const first = (query.page - 1) * query.perPage;
        return {
          items: roster
            .slice(first, first + query.perPage)
            .map(({ accountId, role }) => ({ accountId, role })),
          total: roster.length,
        };
      },
    }),
    getRoute({
      route: memberPermissionsRoute,
      summary: "Check a member's effective permissions for this tenant",
      access,
      params: memberParams,
      response: memberPermissions,
      handler: ({ params, subject }) =>
        tenantRead(() =>
          tenants.memberships.permissions(
            subject.id,
            params.tenantId,
            params.accountId,
          ),
        ),
    }),
  ]);
}

async function tenantRead<Result>(
  read: () => Promise<Result>,
): Promise<Result> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TenantUnavailableError)
      throw notFound("RESOURCE_NOT_FOUND", "Resource not found");
    throw error;
  }
}
