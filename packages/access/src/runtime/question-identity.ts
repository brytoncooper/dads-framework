import type { PermissionQuery, ResourceLookup, SubjectLookup, SubjectRef } from "./authorization.js";

function subjectIdentity(subject: SubjectRef): readonly string[] {
  return [subject.type, subject.id, subject.relation ?? ""];
}

/** The question independent of how fresh its answer must be. */
export function permissionQuestionIdentity(
  query: PermissionQuery,
): readonly [readonly string[], string, string, string] {
  return [subjectIdentity(query.subject), query.permission, query.resource.type, query.resource.id];
}

export function lookupQuestionIdentity(query: ResourceLookup): readonly [readonly string[], string, string] {
  return [subjectIdentity(query.subject), query.permission, query.resourceType];
}

export function subjectLookupQuestionIdentity(query: SubjectLookup): readonly [string, string, string, string] {
  return [query.resource.type, query.resource.id, query.permission, query.subjectType];
}
