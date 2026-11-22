import { conflict, notFound } from "@dads-framework/errors";
import type { DrizzleHandle } from "@dads-framework/postgres";
import {
  PostgresSerializationConflict,
  type PostgresAuthorization,
} from "@dads-framework/postgres-access";
import { withProtectedDrizzleTransaction } from "@dads-framework/postgres-access/drizzle";

import type { WriteWithPermission } from "../libraries/app-runtime/index.js";

export function createProtectedWrite(
  database: DrizzleHandle,
  authorization: PostgresAuthorization,
): WriteWithPermission {
  return async ({ subject, permission, resourceId }, write) => {
    try {
      return await withProtectedDrizzleTransaction(
        { database, authorization },
        async ({ tx, authorization: scoped }) => {
          const allowed = await scoped.check({
            subject,
            permission: permission.permissionName,
            resource: { type: permission.entityWireName, id: resourceId },
          });
          if (!allowed)
            throw notFound("RESOURCE_NOT_FOUND", "Resource not found");
          return write(tx, scoped);
        },
      );
    } catch (fault) {
      if (fault instanceof PostgresSerializationConflict) {
        throw conflict(
          fault.code,
          "The transaction could not finish. Retry the request.",
          { retryable: true },
        );
      }
      throw fault;
    }
  };
}
