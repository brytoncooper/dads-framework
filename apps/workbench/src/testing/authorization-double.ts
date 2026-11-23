import type { Authorization } from "@dads-framework/spicedb-access";
import type { WorkbenchAuthorization } from "../access.js";

type AuthorizationOverrides = Partial<
  Pick<Authorization, "check" | "lookupResources" | "writeRelationships" | "deleteRelationships">
>;

/** Decorates queries and writes while leaving other operations delegated. */
export function createAuthorizationDouble(
  backing: WorkbenchAuthorization,
  overrides: AuthorizationOverrides = {},
): WorkbenchAuthorization {
  const check = overrides.check ?? backing.check.bind(backing);
  return {
    can: backing.can.bind({ check }),
    check,
    lookupResources: overrides.lookupResources ?? backing.lookupResources.bind(backing),
    writeRelationships: overrides.writeRelationships ?? backing.writeRelationships.bind(backing),
    deleteRelationships: overrides.deleteRelationships ?? backing.deleteRelationships.bind(backing),
    relationshipExists: backing.relationshipExists.bind(backing),
    listDirectSubjects: backing.listDirectSubjects.bind(backing),
  };
}

export function testAuthorizationFault(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
