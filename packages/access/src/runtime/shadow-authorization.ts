import {
  Authorization,
  checkOutcome,
  type DirectSubjectLookup,
  type PermissionCheckOutcome,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipWrite,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectLookup,
  type SubjectLookupResult,
  type SubjectRef,
} from "./authorization.js";

export type ShadowAuthorizationMode = "shadow-read" | "primary-new";

export type ShadowMismatchEvent =
  | {
      readonly operation: "check";
      readonly query: PermissionQuery;
      readonly authoritative: boolean;
      readonly comparison: boolean;
    }
  | {
      readonly operation: "checkMany";
      readonly queries: readonly PermissionQuery[];
      readonly authoritative: readonly boolean[];
      readonly comparison: readonly boolean[];
    }
  | {
      readonly operation: "lookupResources";
      readonly query: ResourceLookup;
      readonly authoritative: readonly string[];
      readonly comparison: readonly string[];
    }
  | {
      readonly operation: "lookupSubjects";
      readonly query: SubjectLookup;
      readonly authoritative: SubjectLookupResult;
      readonly comparison: SubjectLookupResult;
    };

export type ShadowErrorOperation =
  | "check"
  | "checkMany"
  | "lookupResources"
  | "lookupSubjects"
  | "writeRelationships"
  | "deleteRelationships";

export type ShadowErrorEvent = {
  readonly operation: ShadowErrorOperation;
  readonly error: Error;
};

export type ShadowAuthorizationOptions = {
  readonly primary: Authorization;
  readonly shadow: Authorization;
  readonly mode?: ShadowAuthorizationMode;
  readonly onMismatch?: (event: ShadowMismatchEvent) => void;
  readonly onShadowError?: (event: ShadowErrorEvent) => void;
};

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function sameBooleanList(
  left: readonly boolean[],
  right: readonly boolean[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const entry of leftSet) {
    if (!rightSet.has(entry)) return false;
  }
  return true;
}

function sameSubjectLookup(
  left: SubjectLookupResult,
  right: SubjectLookupResult,
): boolean {
  return (
    left.hasWildcard === right.hasWildcard &&
    sameStringSet(left.subjects, right.subjects)
  );
}

function runCheckMany(
  backend: Authorization,
  queries: readonly PermissionQuery[],
): Promise<readonly boolean[]> {
  if (backend.checkMany !== undefined) {
    return backend.checkMany(queries);
  }
  return Promise.all(queries.map((query) => backend.check(query)));
}

/**
 * Dual-writing, shadow-comparing `Authorization` wrapper for zero-downtime
 * backend migrations (e.g. SQLite/Postgres to SpiceDB or vice versa).
 */
export class ShadowAuthorization extends Authorization {
  readonly #primary: Authorization;
  readonly #shadow: Authorization;
  readonly #mode: ShadowAuthorizationMode;
  readonly #onMismatch: ((event: ShadowMismatchEvent) => void) | undefined;
  readonly #onShadowError: ((event: ShadowErrorEvent) => void) | undefined;

  constructor(options: ShadowAuthorizationOptions) {
    super();
    this.#primary = options.primary;
    this.#shadow = options.shadow;
    this.#mode = options.mode ?? "shadow-read";
    this.#onMismatch = options.onMismatch;
    this.#onShadowError = options.onShadowError;
  }

  #authoritative(): Authorization {
    return this.#mode === "primary-new" ? this.#shadow : this.#primary;
  }

  #comparison(): Authorization {
    return this.#mode === "primary-new" ? this.#primary : this.#shadow;
  }

  async #runSecondary<T>(
    operation: ShadowErrorOperation,
    task: () => Promise<T>,
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false }
  > {
    try {
      return { ok: true, value: await task() };
    } catch (error) {
      this.#onShadowError?.({ operation, error: toError(error) });
      return { ok: false };
    }
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    const [authoritative, secondary] = await Promise.all([
      this.#authoritative().check(query),
      this.#runSecondary("check", () => this.#comparison().check(query)),
    ]);
    if (secondary.ok && authoritative !== secondary.value) {
      this.#onMismatch?.({
        operation: "check",
        query,
        authoritative,
        comparison: secondary.value,
      });
    }
    return authoritative;
  }

  override async checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    const [authoritative, secondary] = await Promise.all([
      runCheckMany(this.#authoritative(), queries),
      this.#runSecondary("checkMany", () =>
        runCheckMany(this.#comparison(), queries),
      ),
    ]);
    if (secondary.ok && !sameBooleanList(authoritative, secondary.value)) {
      this.#onMismatch?.({
        operation: "checkMany",
        queries,
        authoritative,
        comparison: secondary.value,
      });
    }
    return authoritative;
  }

  override checkEach(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    const backend = this.#authoritative();
    if (backend.checkEach !== undefined) {
      return backend.checkEach(queries);
    }
    return Promise.all(
      queries.map((query) => checkOutcome(() => this.check(query))),
    );
  }

  override async lookupResources(
    query: ResourceLookup,
  ): Promise<readonly string[]> {
    const [authoritative, secondary] = await Promise.all([
      this.#authoritative().lookupResources(query),
      this.#runSecondary("lookupResources", () =>
        this.#comparison().lookupResources(query),
      ),
    ]);
    if (secondary.ok && !sameStringSet(authoritative, secondary.value)) {
      this.#onMismatch?.({
        operation: "lookupResources",
        query,
        authoritative,
        comparison: secondary.value,
      });
    }
    return authoritative;
  }

  override async lookupSubjects(
    query: SubjectLookup,
  ): Promise<SubjectLookupResult> {
    const authLookup = this.#authoritative().lookupSubjects?.bind(
      this.#authoritative(),
    );
    if (authLookup === undefined) {
      throw new Error(
        "authoritative Authorization does not implement lookupSubjects",
      );
    }
    const compLookup = this.#comparison().lookupSubjects?.bind(
      this.#comparison(),
    );
    const skippedSecondary: { readonly ok: false } = { ok: false };
    const [authoritative, secondary] = await Promise.all([
      authLookup(query),
      compLookup === undefined
        ? Promise.resolve(skippedSecondary)
        : this.#runSecondary("lookupSubjects", () => compLookup(query)),
    ]);
    if (secondary.ok && !sameSubjectLookup(authoritative, secondary.value)) {
      this.#onMismatch?.({
        operation: "lookupSubjects",
        query,
        authoritative,
        comparison: secondary.value,
      });
    }
    return authoritative;
  }

  override async writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    const [token] = await Promise.all([
      this.#authoritative().writeRelationships(writes),
      this.#runSecondary("writeRelationships", () =>
        this.#comparison().writeRelationships(writes),
      ),
    ]);
    return token;
  }

  override async deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    const [token] = await Promise.all([
      this.#authoritative().deleteRelationships(filter),
      this.#runSecondary("deleteRelationships", () =>
        this.#comparison().deleteRelationships(filter),
      ),
    ]);
    return token;
  }

  override relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    return this.#authoritative().relationshipExists(filter);
  }

  override listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    return this.#authoritative().listDirectSubjects(query);
  }
}
