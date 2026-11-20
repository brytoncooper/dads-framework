import {
  TenantUnavailableError,
  type TenantId,
  type Tenants,
} from "@dads-framework/tenants";
import { z } from "zod";

import type { Impersonation } from "@dads-framework/identity/impersonation";

const grant = z.strictObject({ grantId: z.uuid() });
const start = z.strictObject({
  effectiveAccountId: z.string().min(1).max(256),
});
const input = z.discriminatedUnion("action", [
  start.extend({ action: z.literal("start") }),
  grant.extend({ action: z.literal("view-tenant") }),
  grant.extend({ action: z.literal("stop") }),
  grant.extend({ action: z.literal("revoke") }),
]);

type StaffImpersonationHandlerOptions = {
  readonly baseUrl: string;
  readonly tenantId: TenantId;
  readonly impersonation: Impersonation;
  readonly tenants: Tenants;
};

export function configureStaffImpersonation(
  options: StaffImpersonationHandlerOptions,
) {
  const trustedOrigin = new URL(options.baseUrl).origin;
  return async function handle(request: Request): Promise<Response> {
    const refused = validateRequest(request, trustedOrigin);
    if (refused !== undefined) return refused;
    const body: unknown = await request.json().catch(() => null);
    const parsed = input.safeParse(body);
    if (!parsed.success) return rejection(400, "INVALID_REQUEST");
    return runCommand(options, request.headers, parsed.data);
  };
}

function validateRequest(request: Request, trustedOrigin: string) {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/api/staff/impersonation"
  ) {
    return rejection(404, "RESOURCE_NOT_FOUND");
  }
  if (request.headers.get("origin") !== trustedOrigin) {
    return rejection(403, "UNTRUSTED_ORIGIN");
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json")
    return rejection(415, "UNSUPPORTED_MEDIA_TYPE");
  return undefined;
}

async function runCommand(
  options: StaffImpersonationHandlerOptions,
  headers: Headers,
  command: z.output<typeof input>,
) {
  const { impersonation, tenantId } = options;
  switch (command.action) {
    case "start": {
      const issued = await impersonation.start(headers, {
        tenantId,
        effectiveAccountId: command.effectiveAccountId,
      });
      return issued === null ? rejectedGrant() : json(issued, 201);
    }
    case "view-tenant":
      return viewTenant(options, headers, command.grantId);
    case "stop":
      return (await impersonation.stop(headers, command.grantId))
        ? json({ stopped: true })
        : rejectedGrant();
    case "revoke":
      return (await impersonation.revoke(headers, command.grantId))
        ? json({ revoked: true })
        : rejectedGrant();
  }
}

async function viewTenant(
  { impersonation, tenants, tenantId }: StaffImpersonationHandlerOptions,
  headers: Headers,
  grantId: string,
) {
  const active = await impersonation.use(headers, { grantId, tenantId });
  if (active === null) return rejectedGrant();
  const view = await readTenantAsTarget(
    tenants,
    active.effectiveAccountId,
    tenantId,
  );
  return view === null
    ? rejectedGrant()
    : json({
        staffAccountId: active.staffAccountId,
        effectiveAccountId: active.effectiveAccountId,
        tenant: { id: view.id, name: view.name },
      });
}

export async function readTenantAsTarget(
  tenants: Tenants,
  accountId: string,
  tenantId: TenantId,
) {
  try {
    return (await tenants.context(accountId, tenantId)).tenant;
  } catch (error) {
    if (error instanceof TenantUnavailableError) return null;
    throw error;
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function rejection(status: number, code: string) {
  return json({ error: { code } }, status);
}

function rejectedGrant() {
  return rejection(404, "RESOURCE_NOT_FOUND");
}
