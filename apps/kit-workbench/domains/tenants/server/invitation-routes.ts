import { apiResponseSchema } from "@dads-framework/core/contract";
import { forbidden, notFound, unauthorized, validation } from "@dads-framework/core/errors";
import { defineRawRoute, fromParam, postRoute, requireSession, requires, routeGroup } from "@dads-framework/http";
import {
  TenantInvitationUnavailableError,
  TenantUnavailableError,
  type TenantId,
} from "@dads-framework/identity/tenants";

import { tenantAccess, type StarterServices } from "../../../libraries/app-runtime/index.js";
import {
  tenantInvitationAcceptance,
  tenantInvitationAccepted,
  tenantInvitationInput,
  tenantInvitationIssued,
  tenantInvitationParams,
} from "../contract/index.js";
import { tenantInvitationOpenApiCopy } from "../copy/invitation-openapi.js";

type InvitationServices = Pick<
  StarterServices,
  "tenants" | "identity" | "readTenantSessionPolicy" | "invitationOrigin" | "enqueueTenantInvitation"
>;

const permission = tenantAccess.tenant.permissions.manage_members;

export function tenantInvitationRoutes(services: InvitationServices) {
  return routeGroup("Tenant invitations", [
    postRoute({
      route: { method: "POST", template: "/tenants/:tenantId/invitations" },
      summary: "Invite a verified email address to this tenant",
      access: requires(permission, fromParam("tenantId")),
      params: tenantInvitationParams,
      body: tenantInvitationInput,
      response: tenantInvitationIssued,
      handler: async ({ body, params, subject }) => {
        const issued = await requestInvitation(services, subject.id, params.tenantId, body.email);
        try {
          await services.enqueueTenantInvitation(body.email, issued.token);
        } catch {
          throw new Error("Tenant invitation delivery is unavailable.");
        }
        return { expiresAt: issued.expiresAt.toISOString() };
      },
    }),
    acceptRoute(services),
  ]);
}

async function requestInvitation({ tenants }: InvitationServices, actor: string, tenant: TenantId, email: string) {
  try {
    return await tenants.invitations.issue(actor, tenant, email);
  } catch (error) {
    if (error instanceof TenantUnavailableError) {
      throw notFound("TENANT_UNAVAILABLE", "The tenant is unavailable.");
    }
    throw error;
  }
}

function acceptRoute({ tenants, identity, invitationOrigin, readTenantSessionPolicy }: InvitationServices) {
  // Acceptance re-reads the verified identity from its cookie. Typed route
  // handlers intentionally receive an authorization subject, not headers.
  return defineRawRoute({
    method: "POST",
    path: "/tenants/invitations/accept",
    summary: "Accept an invitation addressed to the current verified account",
    access: requireSession(),
    openapi: {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TenantInvitationAcceptance" },
          },
        },
      },
      responses: {
        "200": {
          description: tenantInvitationOpenApiCopy["tenants.invitation.joined"].en,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TenantInvitationAccepted" },
            },
          },
        },
      },
    },
    openapiComponents: {
      TenantInvitationAcceptance: tenantInvitationAcceptance,
      TenantInvitationAccepted: apiResponseSchema(tenantInvitationAccepted),
    },
    handler: async ({ request, reply, subject }) => {
      if (request.headers.origin !== invitationOrigin)
        throw forbidden("INVITATION_ORIGIN", "The request origin is not allowed.");
      const policy = await invitationSession(identity, readTenantSessionPolicy, request.headers.cookie);
      const signedIn = policy?.session ?? null;
      if (signedIn === null || !signedIn.account.emailVerified || signedIn.account.id !== subject?.id) {
        throw unauthorized("IDENTITY_REQUIRED", "Sign in with a verified account.");
      }
      const input = tenantInvitationAcceptance.safeParse(request.body);
      if (!input.success) throw validation("INVALID_INVITATION_INPUT", "Supply an invitation token.");
      const tenantId = await redeemInvitation(tenants, input.data.token, signedIn.account, ({ tenantId }) =>
        Promise.resolve(policy?.allowsTenant(tenantId) === true),
      );
      await reply.header("cache-control", "no-store").send({ data: { tenantId } });
    },
  });
}

async function invitationSession(
  identity: InvitationServices["identity"],
  readTenantSessionPolicy: InvitationServices["readTenantSessionPolicy"],
  cookie: string | string[] | undefined,
) {
  if (typeof cookie !== "string") return null;
  const headers = new Headers({ cookie });
  if (readTenantSessionPolicy !== undefined) return readTenantSessionPolicy(headers);
  const session = await identity.readSession(headers);
  return session === null ? null : { session, allowsTenant: () => true };
}

async function redeemInvitation(
  tenants: InvitationServices["tenants"],
  token: string,
  account: Parameters<InvitationServices["tenants"]["invitations"]["accept"]>[1],
  authorize: Parameters<InvitationServices["tenants"]["invitations"]["accept"]>[2],
) {
  try {
    return await tenants.invitations.accept(token, account, authorize);
  } catch (error) {
    if (error instanceof TenantInvitationUnavailableError) {
      throw notFound("TENANT_INVITATION_UNAVAILABLE", "The invitation is unavailable.");
    }
    throw error;
  }
}
