import { v1 } from "@authzed/authzed-node";

import { noteAuthorizationWarning } from "@dads-framework/core/runtime/request-work";

import type { PermissionCheckOutcome, PermissionQuery, SubjectRef } from "@dads-framework/access/runtime";

export type SpiceDbPermissionClient = Pick<ReturnType<typeof v1.NewClient>["promises"], "checkPermission"> &
  Partial<Pick<ReturnType<typeof v1.NewClient>["promises"], "checkBulkPermissions">>;

const PERMISSION_BATCH_SIZE = 128;

/** One check; `consistency` is the adapter's enforcement requirement. */
export async function checkSpiceDbPermission(
  client: SpiceDbPermissionClient,
  query: PermissionQuery,
  consistency: v1.Consistency,
): Promise<boolean> {
  const response = await client.checkPermission(
    v1.CheckPermissionRequest.create({
      resource: v1.ObjectReference.create({
        objectType: query.resource.type,
        objectId: query.resource.id,
      }),
      permission: query.permission,
      subject: toSpiceDbSubjectReference(query.subject),
      consistency,
    }),
  );
  return response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
}

/**
 * Outcomes in input order, 128 per bulk request, every batch at
 * `consistency`. An item SpiceDB answered with an error, or did not answer,
 * is that item's `failed` outcome, handed to `onItemError` as well; a failed
 * request rejects. Without bulk checks each question is asked alone and an
 * error rejects, as `check` does.
 */
export async function checkSpiceDbPermissions(
  client: SpiceDbPermissionClient,
  queries: readonly PermissionQuery[],
  consistency: v1.Consistency,
  onItemError?: (error: Error) => void,
): Promise<readonly PermissionCheckOutcome[]> {
  const outcomes: PermissionCheckOutcome[] = [];
  if (client.checkBulkPermissions === undefined) {
    for (const query of queries) {
      const allowed = await checkSpiceDbPermission(client, query, consistency);
      outcomes.push({ kind: "answered", allowed });
    }
    return outcomes;
  }
  for (let offset = 0; offset < queries.length; offset += PERMISSION_BATCH_SIZE) {
    const batch = queries.slice(offset, offset + PERMISSION_BATCH_SIZE);
    const response = await client.checkBulkPermissions(
      v1.CheckBulkPermissionsRequest.create({
        consistency,
        items: batch.map((query) =>
          v1.CheckBulkPermissionsRequestItem.create({
            resource: v1.ObjectReference.create({
              objectType: query.resource.type,
              objectId: query.resource.id,
            }),
            permission: query.permission,
            subject: toSpiceDbSubjectReference(query.subject),
          }),
        ),
      }),
    );
    batch.forEach((query, index) => {
      const outcome = bulkItemOutcome(query, response.pairs[index]?.response);
      if (outcome.kind === "failed") onItemError?.(outcome.error);
      outcomes.push(outcome);
    });
  }
  return outcomes;
}

/**
 * `checkMany`'s decisions: an item that failed is denied, and the request
 * notes it as a fault naming the wire type and permission only, because
 * SpiceDB's own message may name ids.
 */
export function denyingFailedItems(
  queries: readonly PermissionQuery[],
  outcomes: readonly PermissionCheckOutcome[],
): readonly boolean[] {
  return outcomes.map((outcome, index) => {
    if (outcome.kind === "answered") return outcome.allowed;
    const asked = queries[index];
    noteAuthorizationWarning({
      type: "AuthorizationBulkItemErrorDenied",
      fingerprint: "authz.bulk-item-error",
      detail: `SpiceDB answered ${asked?.permission ?? "a permission"} on ${asked?.resource.type ?? "a resource"} with an error in a bulk check; denied`,
    });
    return false;
  });
}

type BulkItemResponse = v1.CheckBulkPermissionsPair["response"] | undefined;

/** Names wire types and the permission only, never an id. */
function bulkItemOutcome(query: PermissionQuery, response: BulkItemResponse): PermissionCheckOutcome {
  const asked = `${query.permission} on ${query.resource.type} for a ${query.subject.type}`;
  if (response?.oneofKind === "item") {
    return {
      kind: "answered",
      allowed: response.item.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
    };
  }
  if (response?.oneofKind === "error") {
    return {
      kind: "failed",
      error: new Error(
        `SpiceDB could not answer ${asked} in a bulk check (code ${response.error.code}): ${response.error.message}`,
      ),
    };
  }
  return {
    kind: "failed",
    error: new Error(`SpiceDB returned no answer for ${asked} in a bulk check`),
  };
}

export function toSpiceDbSubjectReference(subject: SubjectRef) {
  return v1.SubjectReference.create({
    object: v1.ObjectReference.create({
      objectType: subject.type,
      objectId: subject.id,
    }),
    ...(subject.relation ? { optionalRelation: subject.relation } : {}),
  });
}
