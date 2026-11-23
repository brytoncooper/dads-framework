import { randomUUID } from "node:crypto";

import { outboxKeyForRelationship, type AccessChange, type RelationshipWrite } from "@dads-framework/access/runtime";

import { tenantRoleToken, type TenantId, type TenantRole } from "./tenant-access.js";
import { accountSubject, type TenantsOptions } from "./tenant-transaction.js";

export function membershipFact(
  options: TenantsOptions,
  tenantId: TenantId,
  accountId: string,
  role: TenantRole,
  operation: AccessChange["operation"],
): AccessChange {
  const token = tenantRoleToken(options.access, role);
  const relationship: RelationshipWrite = {
    resource: { type: token.entityWireName, id: tenantId },
    relation: token.roleName,
    subject: accountSubject(options, accountId),
  };
  return {
    idempotencyKey: outboxKeyForRelationship(operation, relationship, randomUUID()),
    relationship,
    operation,
    ownerPartitionId: tenantId,
  };
}
