import {
  getPageFromApi,
  sendToApi,
} from "@dads-framework/client-request-transport";
import { defineRoute, paginationQuerySchema } from "@dads-framework/contract";
import type { z } from "zod";
import {
  tenantInput,
  tenantRecord,
  tenantInvitationAcceptance,
  tenantInvitationAccepted,
  tenantInvitationInput,
  tenantInvitationIssued,
} from "../contract/wire.js";

export type Tenant = z.output<typeof tenantRecord>;

const list = defineRoute("GET", "/tenants", () => "/tenants");
const create = defineRoute("POST", "/tenants", () => "/tenants");
const accept = defineRoute(
  "POST",
  "/tenants/invitations/accept",
  () => "/tenants/invitations/accept",
);
const invite = defineRoute(
  "POST",
  "/tenants/:tenantId/invitations",
  (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/invitations`,
);

export async function listTenants(signal?: AbortSignal): Promise<Tenant[]> {
  const tenants: Tenant[] = [];
  for (let page = 1; ; page += 1) {
    const { items, meta } = await getPageFromApi({
      route: list.bind(),
      returns: tenantRecord,
      query: { schema: paginationQuerySchema, value: { page, perPage: 50 } },
      ...(signal === undefined ? {} : { signal }),
    });
    tenants.push(...items);
    if (items.length === 0 || meta.page * meta.perPage >= meta.total)
      return tenants;
  }
}

export function createTenant(name: string) {
  return sendToApi({
    route: create.bind(),
    body: { schema: tenantInput, value: { name } },
    returns: tenantRecord,
  });
}

export function inviteToTenant(tenantId: string, email: string) {
  return sendToApi({
    route: invite.bind(tenantId),
    body: { schema: tenantInvitationInput, value: { email } },
    returns: tenantInvitationIssued,
  });
}

export function acceptTenantInvitation(token: string) {
  return sendToApi({
    route: accept.bind(),
    body: { schema: tenantInvitationAcceptance, value: { token } },
    returns: tenantInvitationAccepted,
  });
}

export { readMemberPermissions, readPermissionRoster } from "./permissions.js";
