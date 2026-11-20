import type { v1 } from "@authzed/authzed-node";

import type { RelationshipWrite } from "@dads-framework/access/runtime";

/** One relationship SpiceDB read back, as the port's tuple; incomplete ones throw. */
export function relationshipFromSpiceDb(
  item: v1.ReadRelationshipsResponse,
): RelationshipWrite {
  const relationship = item.relationship;
  if (relationship === undefined) {
    throw new Error("Incomplete relationship in authorization migration read");
  }
  const { resource, subject, relation } = relationship;
  if (!resource || !subject?.object || !relation) {
    throw new Error("Incomplete relationship in authorization migration read");
  }
  return {
    resource: { type: resource.objectType, id: resource.objectId },
    relation,
    subject: {
      type: subject.object.objectType,
      id: subject.object.objectId,
      ...(subject.optionalRelation
        ? { relation: subject.optionalRelation }
        : {}),
    },
  };
}
