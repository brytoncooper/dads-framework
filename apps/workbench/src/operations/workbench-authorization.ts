import {
  checkAll,
  type PermissionQuery,
  type ResourceLookup,
} from "@dads-framework/spicedb-access";
import type { WorkbenchAuthorization } from "../access.js";
import type { PendingAuthorizationChange } from "../storage/workbench-state.js";
import { WorkbenchError } from "./workbench-error.js";

export async function checkWorkbenchPermission(
  authorization: WorkbenchAuthorization,
  query: PermissionQuery,
): Promise<boolean> {
  try {
    return await authorization.check(query);
  } catch (cause) {
    throw workbenchAuthorizationReadError(cause);
  }
}

export async function checkWorkbenchPermissions(
  authorization: WorkbenchAuthorization,
  queries: readonly PermissionQuery[],
): Promise<readonly boolean[]> {
  try {
    const decisions = await checkAll(authorization, queries);
    if (decisions.length !== queries.length)
      throw new Error("Authorization returned the wrong number of decisions.");
    return decisions;
  } catch (cause) {
    throw workbenchAuthorizationReadError(cause);
  }
}

export async function lookupWorkbenchResources(
  authorization: WorkbenchAuthorization,
  query: ResourceLookup,
): Promise<readonly string[]> {
  try {
    return await authorization.lookupResources(query);
  } catch (cause) {
    throw workbenchAuthorizationReadError(cause);
  }
}

export async function applyWorkbenchRelationships(
  authorization: WorkbenchAuthorization,
  change: PendingAuthorizationChange,
): Promise<void> {
  for (let offset = 0; offset < change.writes.length; offset += 500) {
    await authorization.writeRelationships(
      change.writes.slice(offset, offset + 500),
    );
  }
  for (const deletion of change.deletes) {
    await authorization.deleteRelationships({
      resourceType: deletion.resource.type,
      resourceId: deletion.resource.id,
      relation: deletion.relation,
      subject: deletion.subject,
    });
  }
}

export function workbenchAuthorizationReadError(cause: unknown): unknown {
  if (typeof cause !== "object" || cause === null || !("code" in cause))
    return cause;
  const serviceFailures: readonly unknown[] = [
    4,
    8,
    14,
    "UNAVAILABLE",
    "LIMIT_EXCEEDED",
    "ECONNREFUSED",
    "ECONNRESET",
    "57P01",
  ];
  return serviceFailures.includes(cause.code)
    ? new WorkbenchError("AUTHORIZATION_UNAVAILABLE", { cause })
    : cause;
}
