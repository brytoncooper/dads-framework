import type { SubjectLookup, SubjectLookupResult, SubjectRef } from "@dads-framework/access/runtime";
import { readBooleanColumn, readStringColumn } from "./sqlite-types.js";

export function collectSubjectLookupResult(rows: readonly Readonly<Record<string, unknown>>[]): SubjectLookupResult {
  const subjects: string[] = [];
  let hasWildcard = false;
  for (const row of rows) {
    if (readBooleanColumn(row, "is_wildcard")) {
      hasWildcard = true;
    } else {
      subjects.push(readStringColumn(row, "subject_id"));
    }
  }
  return { subjects, hasWildcard };
}

export function requireConcreteSubject(subject: SubjectRef): void {
  if (subject.id.length === 0 || subject.id === "*" || subject.relation !== undefined) {
    throw new Error("SQLite authorization reads require a concrete subject");
  }
}

export function requireSubjectLookupInput(query: SubjectLookup): void {
  if (query.resource.type.length === 0 || query.resource.id.length === 0 || query.subjectType.length === 0) {
    throw new Error("SQLite lookupSubjects requires resource type, resource id, and subject type");
  }
}
