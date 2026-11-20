import { conflict, notFound } from "@dads-framework/errors";
import { ServiceUnavailableError } from "@dads-framework/http";
import { PostgresSerializationConflict } from "@dads-framework/postgres-access";
import {
  authorizationUnavailable,
  postgresWriteConflict,
  relationshipsPending,
  resourceNotFound,
  workbenchConflict,
} from "./contracts.js";
import { WorkbenchError } from "./operations/workbench-error.js";

/** Only the HTTP edge translates application failures into the public HTTP contract. */
export async function routeOutcome<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof PostgresSerializationConflict)
      throw conflict(error.code, postgresWriteConflict.defaultMessage, {
        retryable: error.retryable,
      });

    if (!(error instanceof WorkbenchError)) throw error;
    if (error.code === "NOT_FOUND") {
      throw notFound(resourceNotFound.code, resourceNotFound.defaultMessage);
    }
    if (error.code === "CONFLICT") {
      throw conflict(workbenchConflict.code, workbenchConflict.defaultMessage);
    }
    if (error.code === "AUTHORIZATION_UNAVAILABLE") {
      throw new ServiceUnavailableError(
        authorizationUnavailable.code,
        authorizationUnavailable.defaultMessage,
      );
    }
    throw new ServiceUnavailableError(
      relationshipsPending.code,
      relationshipsPending.defaultMessage,
    );
  }
}

export async function listOutcome<Item>(
  operation: () => Promise<{
    readonly data: readonly Item[];
    readonly meta: { readonly total: number; readonly pageCount: number };
  }>,
) {
  const { data, meta } = await routeOutcome(operation);
  return {
    items: data,
    total: meta.total,
    meta: { pageCount: meta.pageCount },
  };
}
