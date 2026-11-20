import type {
  CreateRequestRecord,
  WorkbenchState,
} from "../storage/workbench-state.js";
import { WorkbenchError } from "./workbench-error.js";

/** A fixed local-app capacity: entries never expire or disappear when their resource is deleted. */
export const createRequestLimit = 10_000;

export type CreateRequest = Omit<CreateRequestRecord, "resourceId">;

export function findCreateRequest(
  state: WorkbenchState,
  request: CreateRequest,
): CreateRequestRecord | undefined {
  const previous = state.createRequests.find(
    (entry) =>
      entry.subjectType === request.subjectType &&
      entry.subjectId === request.subjectId &&
      entry.operation === request.operation &&
      entry.parentId === request.parentId &&
      entry.requestKey === request.requestKey,
  );
  if (
    previous &&
    (previous.payload[0] !== request.payload[0] ||
      previous.payload[1] !== request.payload[1])
  )
    throw new WorkbenchError("CONFLICT");
  return previous;
}

export function requireCreateCapacity(state: WorkbenchState): void {
  if (state.createRequests.length >= createRequestLimit)
    throw new WorkbenchError("CONFLICT");
}

export function findCreatedResource<Resource extends { readonly id: string }>(
  resources: readonly Resource[],
  id: string,
): Resource {
  const resource = resources.find((entry) => entry.id === id);
  if (!resource) throw new WorkbenchError("CONFLICT");
  return resource;
}
