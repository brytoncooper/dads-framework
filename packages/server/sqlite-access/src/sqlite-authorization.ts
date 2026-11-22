import type { AccessModel } from "@dads-framework/access";
import {
  Authorization,
  type AccessChange,
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
} from "@dads-framework/access/runtime";

import {
  compileAccessPolicy,
  type CompiledSqliteAccessPolicy,
} from "./policy/compile-access-policy.js";
import {
  compileSqliteCheck,
  compileSqliteCheckMany,
} from "./policy/compile-check.js";
import {
  compileSqliteFilter,
  validateSqliteFilterQuery,
  type SqliteAccessFilter,
  type SqliteFilterQuery,
} from "./policy/compile-filter.js";
import { compileSqliteLookupResources } from "./policy/compile-lookup-resources.js";
import { compileSqliteLookupSubjects } from "./policy/compile-lookup-subjects.js";
import type { SqlitePermissionCheck } from "./policy/policy-model.js";
import type { SqliteExecutor } from "./sqlite-executor.js";
import { SqliteTuples } from "./sqlite-tuples.js";
import {
  readBooleanColumn,
  readDecisionFlag,
  readStringColumn,
} from "./sqlite-types.js";

const CHECK_BATCH_SIZE = 64;
const compiledPolicyCache = new WeakMap<
  AccessModel,
  CompiledSqliteAccessPolicy
>();

export type SqliteAccessOptions = {
  readonly model: AccessModel;
  readonly namespace: string;
  readonly executor: SqliteExecutor;
  readonly now?: () => Date;
};

type PreparedBatchItem =
  | { readonly kind: "known"; readonly check: SqlitePermissionCheck }
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly error: Error };

/** Authorization backend backed by SQLite via Node built-in `node:sqlite` or compatible executors. */
export class SqliteAuthorization extends Authorization {
  readonly #model: AccessModel;
  readonly #executor: SqliteExecutor;
  readonly #policy: CompiledSqliteAccessPolicy;
  readonly #namespace: string;
  readonly #now: () => Date;
  readonly #tuples: SqliteTuples;

  constructor(options: SqliteAccessOptions) {
    super();
    if (options.namespace.trim() === "") {
      throw new Error("SQLite authorization namespace is required");
    }
    this.#model = options.model;
    this.#namespace = options.namespace;
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date());
    this.#policy = getOrCompilePolicy(options.model);
    this.#tuples = new SqliteTuples(
      this.#policy.model,
      this.#namespace,
      this.#executor,
    );
  }

  /** Return the current evaluation timestamp in epoch milliseconds. */
  currentTimeMs(): number {
    return this.#now().getTime();
  }

  /** Bind every operation to a transaction-scoped executor and optional pinned clock. */
  inTransaction(
    executor: SqliteExecutor,
    now?: () => Date,
  ): SqliteAuthorization {
    return new SqliteAuthorization({
      model: this.#model,
      namespace: this.#namespace,
      executor,
      now: now ?? this.#now,
    });
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    const normalized = this.#normalizeCheck(query);
    if (normalized === undefined) return false;
    const compiled = compileSqliteCheck(
      this.#policy.model,
      this.#namespace,
      this.currentTimeMs(),
      normalized,
    );
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    return readDecisionFlag(rows[0]);
  }

  override async checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    const nowMs = this.currentTimeMs();
    const answers: boolean[] = [];
    for (let offset = 0; offset < queries.length; offset += CHECK_BATCH_SIZE) {
      const slice = queries.slice(offset, offset + CHECK_BATCH_SIZE);
      answers.push(...(await this.#checkBatch(slice, nowMs)));
    }
    return answers;
  }

  override async checkEach(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    const nowMs = this.currentTimeMs();
    const outcomes: PermissionCheckOutcome[] = [];
    for (let offset = 0; offset < queries.length; offset += CHECK_BATCH_SIZE) {
      const slice = queries.slice(offset, offset + CHECK_BATCH_SIZE);
      outcomes.push(...(await this.#checkEachBatch(slice, nowMs)));
    }
    return outcomes;
  }

  /** Compile a parameterized SQLite Boolean filter predicate for single-query resource listing. */
  compileFilter(query: SqliteFilterQuery): SqliteAccessFilter {
    requireConcreteSubject(query.subject);
    const { idColumn, nowMs, scopeColumns } = validateSqliteFilterQuery(
      query,
      this.currentTimeMs(),
    );
    const permission = this.#policy.permissionName(
      query.resourceType,
      query.permission,
    );
    if (permission === undefined) {
      return Object.freeze({ sql: "0 = 1", values: [] });
    }
    return compileSqliteFilter(
      this.#policy.model,
      this.#namespace,
      nowMs,
      {
        subject: { type: query.subject.type, id: query.subject.id },
        permission,
        resourceType: query.resourceType,
      },
      idColumn,
      scopeColumns,
    );
  }

  override async lookupResources(
    query: ResourceLookup,
  ): Promise<readonly string[]> {
    requireConcreteSubject(query.subject);
    const permission = this.#policy.permissionName(
      query.resourceType,
      query.permission,
    );
    if (permission === undefined) return [];
    const compiled = compileSqliteLookupResources(
      this.#policy.model,
      this.#namespace,
      this.currentTimeMs(),
      {
        subject: { type: query.subject.type, id: query.subject.id },
        permission,
        resourceType: query.resourceType,
      },
    );
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    return rows.map((row) => readStringColumn(row, "resource_id"));
  }

  override async lookupSubjects(
    query: SubjectLookup,
  ): Promise<SubjectLookupResult> {
    requireSubjectLookupInput(query);
    const permission = this.#policy.permissionName(
      query.resource.type,
      query.permission,
    );
    if (permission === undefined) {
      return { subjects: [], hasWildcard: false };
    }
    const compiled = compileSqliteLookupSubjects(
      this.#policy.model,
      this.#namespace,
      this.currentTimeMs(),
      {
        resource: { type: query.resource.type, id: query.resource.id },
        permission,
        subjectType: query.subjectType,
      },
    );
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    return collectSubjectLookupResult(rows);
  }

  /** Apply exact facts to this executor. Bind to a transaction first when atomic. */
  async applyChanges(entries: readonly AccessChange[]): Promise<void> {
    for (const entry of entries) {
      if (entry.operation === "WRITE") {
        await this.#tuples.write([entry.relationship]);
      } else {
        await this.#tuples.remove(entry.relationship);
      }
    }
  }

  override async writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    await this.#tuples.write(writes);
    return "";
  }

  override async deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    await this.#tuples.delete(filter);
    return "";
  }

  override relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    return this.#tuples.exists(filter, this.currentTimeMs());
  }

  override listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    return this.#tuples.list(query, this.currentTimeMs());
  }

  async #checkBatch(
    queries: readonly PermissionQuery[],
    nowMs: number,
  ): Promise<readonly boolean[]> {
    const normalized = queries.map((query) => this.#normalizeCheck(query));
    const known = normalized.filter(
      (entry): entry is SqlitePermissionCheck => entry !== undefined,
    );
    if (known.length === 0) return normalized.map(() => false);
    const compiled = compileSqliteCheckMany(
      this.#policy.model,
      this.#namespace,
      nowMs,
      known,
    );
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    if (rows.length !== known.length) {
      throw new Error("SQLite authorization omitted a decision");
    }
    let index = 0;
    return normalized.map((entry) =>
      entry === undefined ? false : readDecisionFlag(rows[index++]),
    );
  }

  async #checkEachBatch(
    queries: readonly PermissionQuery[],
    nowMs: number,
  ): Promise<readonly PermissionCheckOutcome[]> {
    const prepared = queries.map((query) => this.#prepareBatchItem(query));
    const known = prepared
      .filter(
        (
          entry,
        ): entry is Extract<PreparedBatchItem, { readonly kind: "known" }> =>
          entry.kind === "known",
      )
      .map((entry) => entry.check);
    const rows =
      known.length === 0 ? [] : await this.#runCheckMany(known, nowMs);
    let index = 0;
    return prepared.map((entry): PermissionCheckOutcome => {
      if (entry.kind === "failed")
        return { kind: "failed", error: entry.error };
      if (entry.kind === "unknown") return { kind: "answered", allowed: false };
      return { kind: "answered", allowed: readDecisionFlag(rows[index++]) };
    });
  }

  async #runCheckMany(known: readonly SqlitePermissionCheck[], nowMs: number) {
    const compiled = compileSqliteCheckMany(
      this.#policy.model,
      this.#namespace,
      nowMs,
      known,
    );
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    if (rows.length !== known.length) {
      throw new Error("SQLite authorization omitted a decision");
    }
    return rows;
  }

  #prepareBatchItem(query: PermissionQuery): PreparedBatchItem {
    try {
      const normalized = this.#normalizeCheck(query);
      return normalized === undefined
        ? { kind: "unknown" }
        : { kind: "known", check: normalized };
    } catch (error) {
      return {
        kind: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  #normalizeCheck(query: PermissionQuery): SqlitePermissionCheck | undefined {
    requireConcreteSubject(query.subject);
    const permission = this.#policy.permissionName(
      query.resource.type,
      query.permission,
    );
    if (permission === undefined) return undefined;
    return {
      subject: { type: query.subject.type, id: query.subject.id },
      resource: { type: query.resource.type, id: query.resource.id },
      permission,
    };
  }
}

function getOrCompilePolicy(model: AccessModel): CompiledSqliteAccessPolicy {
  const cached = compiledPolicyCache.get(model);
  if (cached !== undefined) return cached;
  const compiled = compileAccessPolicy(model);
  compiledPolicyCache.set(model, compiled);
  return compiled;
}

function collectSubjectLookupResult(
  rows: readonly Readonly<Record<string, unknown>>[],
): SubjectLookupResult {
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

function requireConcreteSubject(subject: SubjectRef): void {
  if (
    subject.id.length === 0 ||
    subject.id === "*" ||
    subject.relation !== undefined
  ) {
    throw new Error("SQLite authorization reads require a concrete subject");
  }
}

function requireSubjectLookupInput(query: SubjectLookup): void {
  if (
    query.resource.type.length === 0 ||
    query.resource.id.length === 0 ||
    query.subjectType.length === 0
  ) {
    throw new Error(
      "SQLite lookupSubjects requires resource type, resource id, and subject type",
    );
  }
}
