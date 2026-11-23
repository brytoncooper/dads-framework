export type WriteSchemaBlocker =
  | {
      kind: "removed-type";
      resourceType: string;
    }
  | {
      kind: "removed-relation";
      resourceType: string;
      relation: string;
    }
  | {
      kind: "removed-allowed-type";
      resourceType: string;
      relation: string;
      subjectType: string;
      subjectRelation?: string;
    };

export function parseWriteSchemaBlocker(message: string): WriteSchemaBlocker | undefined {
  return parseRemovedRelation(message) ?? parseRemovedType(message) ?? parseRemovedAllowedType(message);
}

function parseRemovedRelation(message: string): WriteSchemaBlocker | undefined {
  const match = /cannot delete relation [`']([^`']+)[`'] in object definition [`']([^`']+)[`']/i.exec(message);
  const relation = match?.[1];
  const resourceType = match?.[2];
  if (relation === undefined || resourceType === undefined) {
    return undefined;
  }
  return { kind: "removed-relation", resourceType, relation };
}

function parseRemovedType(message: string): WriteSchemaBlocker | undefined {
  const match = /cannot delete object definition [`']([^`']+)[`']/i.exec(message);
  const resourceType = match?.[1];
  if (resourceType === undefined) {
    return undefined;
  }
  return { kind: "removed-type", resourceType };
}

function parseRemovedAllowedType(message: string): WriteSchemaBlocker | undefined {
  const match =
    /cannot remove allowed type [`']([^`'#]+)(?:#([^`']+))?[`'] from relation [`']([^`']+)[`'] in object definition [`']([^`']+)[`']/i.exec(
      message,
    );
  const subjectType = match?.[1];
  const subjectRelation = match?.[2];
  const relation = match?.[3];
  const resourceType = match?.[4];
  if (subjectType === undefined || relation === undefined || resourceType === undefined) {
    return undefined;
  }
  return {
    kind: "removed-allowed-type",
    resourceType,
    relation,
    subjectType,
    ...(subjectRelation === undefined ? {} : { subjectRelation }),
  };
}
