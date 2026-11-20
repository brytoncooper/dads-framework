import type {
  Authorization,
  DirectSubjectLookup,
  PermissionQuery,
  RelationshipFilter,
  RelationshipWrite,
  ResourceLookup,
  SpiceDbConsistencyToken,
  SubjectRef,
} from "./authorization.js";
import {
  lookupQuestionIdentity,
  permissionQuestionIdentity,
} from "./question-identity.js";

type CheckAnswer = { query: PermissionQuery; answer: boolean };
type LookupAnswer = { query: ResourceLookup; answer: readonly string[] };
type RecordingAuthorizationOptions = {
  checks?: readonly CheckAnswer[];
  lookups?: readonly LookupAnswer[];
};

/** An explicit-answer fake for decision tests; it records questions but never evaluates tuples or arrows. */
export class RecordingAuthorization implements Authorization {
  readonly questions: (
    | { kind: "check"; query: PermissionQuery }
    | { kind: "lookup"; query: ResourceLookup }
  )[] = [];
  constructor(private readonly answers: RecordingAuthorizationOptions = {}) {
    this.rejectDuplicateAnswers(answers.checks ?? [], permissionKey, "check");
    this.rejectDuplicateAnswers(
      answers.lookups ?? [],
      lookupAnswerKey,
      "lookup",
    );
  }
  check(query: PermissionQuery): Promise<boolean> {
    this.questions.push({ kind: "check", query });
    return Promise.resolve().then(
      () =>
        this.find(this.answers.checks ?? [], permissionKey, query, "check")
          .answer,
    );
  }
  lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    this.questions.push({ kind: "lookup", query });
    return Promise.resolve().then(
      () =>
        this.find(this.answers.lookups ?? [], lookupAnswerKey, query, "lookup")
          .answer,
    );
  }
  writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    void writes;
    return Promise.reject(
      new Error(
        "RecordingAuthorization does not support tuple mutation; use FakeAuthorization",
      ),
    );
  }
  deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    void filter;
    return Promise.reject(
      new Error(
        "RecordingAuthorization does not support tuple mutation; use FakeAuthorization",
      ),
    );
  }
  relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    void filter;
    return Promise.reject(
      new Error(
        "RecordingAuthorization does not support tuple inspection; use FakeAuthorization",
      ),
    );
  }
  listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    void query;
    return Promise.reject(
      new Error(
        "RecordingAuthorization does not support tuple inspection; use FakeAuthorization",
      ),
    );
  }
  private find<T extends { query: object; answer: unknown }>(
    answers: readonly T[],
    keyOf: (query: T["query"]) => string,
    query: T["query"],
    kind: string,
  ): T {
    const key = keyOf(query);
    const found = answers.find((candidate) => keyOf(candidate.query) === key);
    if (!found)
      throw new Error(`RecordingAuthorization unanswered ${kind}: ${key}`);
    return found;
  }
  private rejectDuplicateAnswers<T extends { query: object }>(
    answers: readonly T[],
    keyOf: (query: T["query"]) => string,
    kind: string,
  ): void {
    const keys = answers.map((answer) => keyOf(answer.query));
    if (new Set(keys).size !== keys.length)
      throw new Error(`RecordingAuthorization duplicate ${kind} answer`);
  }
}

function permissionKey(query: PermissionQuery): string {
  return JSON.stringify(permissionQuestionIdentity(query));
}

function lookupAnswerKey(query: ResourceLookup): string {
  return JSON.stringify(lookupQuestionIdentity(query));
}
