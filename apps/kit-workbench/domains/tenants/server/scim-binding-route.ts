import { forbidden, notFound, validation } from "@dads-framework/errors";
import {
  defineRawRoute,
  fromParam,
  requires,
  routeGroup,
} from "@dads-framework/http";
import { TenantUnavailableError, type Tenants } from "@dads-framework/tenants";

import { tenantAccess } from "../../../libraries/app-runtime/index.js";
import {
  scimBindingInput,
  scimBindingParams,
  scimBindingPath,
} from "../contract/scim-binding-wire.js";
import { scimBindingCopy } from "../copy/scim-binding-copy.js";

export function scimBindingRoutes(
  tenants: Pick<Tenants, "bindScimUser">,
  origin: string,
  enabledTenantIds: readonly string[],
) {
  const enabledTenants = new Set(
    enabledTenantIds.map((tenantId) => tenantId.toLowerCase()),
  );
  return routeGroup(scimBindingCopy["tenants.scimBinding.tag"].en, [
    defineRawRoute({
      method: "POST",
      path: scimBindingPath,
      summary: scimBindingCopy["tenants.scimBinding.summary"].en,
      access: requires(
        tenantAccess.tenant.permissions.manage_tenant,
        fromParam("tenantId"),
      ),
      openapi: {
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "scimUserId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ScimAccountBinding" },
            },
          },
        },
        responses: {
          "204": {
            description: scimBindingCopy["tenants.scimBinding.success"].en,
          },
        },
      },
      openapiComponents: { ScimAccountBinding: scimBindingInput },
      handler: async ({ request, reply, subject, authenticatedSubject }) => {
        if (request.headers.origin !== origin)
          throw forbidden(
            "SCIM_BINDING_ORIGIN",
            scimBindingCopy["tenants.scimBinding.origin"].en,
          );
        const params = scimBindingParams.safeParse(request.params);
        const input = scimBindingInput.safeParse(request.body);
        if (!params.success || !input.success)
          throw validation(
            "INVALID_SCIM_BINDING",
            scimBindingCopy["tenants.scimBinding.invalid"].en,
          );
        const { tenantId, scimUserId } = params.data;
        if (
          subject === null ||
          subject.id !== authenticatedSubject?.id ||
          subject.type !== authenticatedSubject.type ||
          !enabledTenants.has(tenantId.toLowerCase())
        )
          throw bindingUnavailable();
        try {
          await tenants.bindScimUser(
            subject.id,
            tenantId,
            scimUserId,
            input.data.accountId,
          );
        } catch (error) {
          if (error instanceof TenantUnavailableError)
            throw bindingUnavailable();
          throw error;
        }
        await reply.header("cache-control", "no-store").code(204).send();
      },
    }),
  ]);
}

function bindingUnavailable() {
  return notFound(
    "RESOURCE_NOT_FOUND",
    scimBindingCopy["tenants.scimBinding.unavailable"].en,
  );
}
