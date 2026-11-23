import type { AccessModel, DslPermissionTarget, PermissionToken } from "@dads-framework/access";
import {
  Authorization,
  permissionQueryFromCan,
  type AccessChange,
  type AuthorizationCanOptions,
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
  verifySqliteColumnRelations,
  type SqliteColumnRelationBinding,
  type SqliteColumnRelationCheckResult,
} from "./policy/column-relations.js";
import type { CompiledSqliteAccessPolicy } from "./policy/compile-access-policy.js";
import { getOrCompileSqlitePolicy } from "./sqlite-policy-cache.js";
import { compileSqliteCheck } from "./policy/compile-check.js";
import {
  compileSqliteFilter,
  resolveSqliteFilterTarget,
  validateSqliteFilterQuery,
  type SqliteAccessFilter,
  type SqliteFilterQuery,
} from "./policy/compile-filter.js";
import { compileSqliteLookupResources } from "./policy/compile-lookup-resources.js";
import { compileSqliteLookupSubjects } from "./policy/compile-lookup-subjects.js";
import { normalizeSqliteCheck, runSqliteCheckBatch, runSqliteCheckEachBatch } from "./sqlite-check-batch.js";
import type { SqliteExecutor } from "./sqlite-executor.js";
import { SqliteTuples } from "./sqlite-tuples.js";
import { readDecisionFlag, readStringColumn } from "./sqlite-types.js";
import { collectSubjectLookupResult, requireConcreteSubject, requireSubjectLookupInput } from "./sqlite-validation.js";

const CHECK_BATCH_SIZE = 64;

export type SqliteAccessOptions = {
  readonly model: AccessModel;
  readonly namespace: string;
  readonly executor: SqliteExecutor;
  readonly now?: () => Date;
  /**
   * Bind single-target FK relations directly to columns on SQLite application
   * tables so authorization reads those columns directly with zero dual-writes.
   */
  readonly columnRelations?: readonly SqliteColumnRelationBinding[];
};

/** Authorization backend backed by SQLite via Node built-in `node:sqlite` or compatible executors. */
export class SqliteAuthorization extends Authorization {
  readonly #model: AccessModel;
  readonly #executor: SqliteExecutor;
  readonly #policy: CompiledSqliteAccessPolicy;
  readonly #namespace: string;
  readonly #now: () => Date;
  readonly #tuples: SqliteTuples;
  readonly #columnRelations: readonly SqliteColumnRelationBinding[] | undefined;

  constructor(options: SqliteAccessOptions) {
    super();
    if (options.namespace.trim() === "") {
      throw new Error("SQLite authorization namespace is required");
    }
    this.#model = options.model;
    this.#namespace = options.namespace;
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date());
    this.#columnRelations = options.columnRelations;
    this.#policy = getOrCompileSqlitePolicy(options.model, options.columnRelations);
    this.#tuples = new SqliteTuples(this.#policy.model, this.#namespace, this.#executor);
  }

  /** Return the current evaluation timestamp in epoch milliseconds. */
  currentTimeMs(): number {
    return this.#now().getTime();
  }

  /** Bind every operation to a transaction-scoped executor and optional pinned clock. */
  inTransaction(executor: SqliteExecutor, now?: () => Date): SqliteAuthorization {
    return new SqliteAuthorization({
      model: this.#model,
      namespace: this.#namespace,
      executor,
      now: now ?? this.#now,
      ...(this.#columnRelations === undefined ? {} : { columnRelations: this.#columnRelations }),
    });
  }

  /**
   * Verify every configured `columnRelations` table and column exists in SQLite
   * and report whether the recommended reverse-lookup index exists.
   */
  verifyColumnRelations(): Promise<readonly SqliteColumnRelationCheckResult[]> {
    return verifySqliteColumnRelations(this.#policy.model.columnRelations ?? [], this.#executor);
  }

  /** Typed permission check accepting `document(id).edit` or `(document.permissions.edit, id)`. */
  can(subject: SubjectRef, target: DslPermissionTarget, options?: AuthorizationCanOptions): Promise<boolean>;
  can(
    subject: SubjectRef,
    permission: PermissionToken,
    resourceId: string,
    options?: AuthorizationCanOptions,
  ): Promise<boolean>;
  can(
    subject: SubjectRef,
    permissionOrTarget: DslPermissionTarget | PermissionToken,
    resourceIdOrOptions?: string | AuthorizationCanOptions,
    maybeOptions?: AuthorizationCanOptions,
  ): Promise<boolean> {
    return this.check(permissionQueryFromCan(subject, permissionOrTarget, resourceIdOrOptions, maybeOptions));
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    const normalized = normalizeSqliteCheck(this.#policy, query);
    if (normalized === undefined) return false;
    const compiled = compileSqliteCheck(this.#policy.model, this.#namespace, this.currentTimeMs(), normalized);
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    return readDecisionFlag(rows[0]);
  }

  override async checkMany(queries: readonly PermissionQuery[]): Promise<readonly boolean[]> {
    const nowMs = this.currentTimeMs();
    const context = {
      policy: this.#policy,
      namespace: this.#namespace,
      executor: this.#executor,
    };
    const answers: boolean[] = [];
    for (let offset = 0; offset < queries.length; offset += CHECK_BATCH_SIZE) {
      const slice = queries.slice(offset, offset + CHECK_BATCH_SIZE);
      answers.push(...(await runSqliteCheckBatch(context, slice, nowMs)));
    }
    return answers;
  }

  override async checkEach(queries: readonly PermissionQuery[]): Promise<readonly PermissionCheckOutcome[]> {
    const nowMs = this.currentTimeMs();
    const context = {
      policy: this.#policy,
      namespace: this.#namespace,
      executor: this.#executor,
    };
    const outcomes: PermissionCheckOutcome[] = [];
    for (let offset = 0; offset < queries.length; offset += CHECK_BATCH_SIZE) {
      const slice = queries.slice(offset, offset + CHECK_BATCH_SIZE);
      outcomes.push(...(await runSqliteCheckEachBatch(context, slice, nowMs)));
    }
    return outcomes;
  }

  /** Compile a parameterized SQLite Boolean filter predicate for single-query resource listing. */
  compileFilter(query: SqliteFilterQuery): SqliteAccessFilter {
    requireConcreteSubject(query.subject);
    const target = resolveSqliteFilterTarget(query);
    const { idColumn, nowMs, scopeColumns } = validateSqliteFilterQuery(
      { ...query, resourceType: target.resourceType },
      this.currentTimeMs(),
      this.#policy.model,
    );
    const permission = this.#policy.permissionName(target.resourceType, target.permission);
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
        resourceType: target.resourceType,
      },
      idColumn,
      scopeColumns,
    );
  }

  override async lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    requireConcreteSubject(query.subject);
    const permission = this.#policy.permissionName(query.resourceType, query.permission);
    if (permission === undefined) return [];
    const compiled = compileSqliteLookupResources(this.#policy.model, this.#namespace, this.currentTimeMs(), {
      subject: { type: query.subject.type, id: query.subject.id },
      permission,
      resourceType: query.resourceType,
    });
    const rows = await this.#executor.all(compiled.sql, compiled.params);
    return rows.map((row) => readStringColumn(row, "resource_id"));
  }

  override async lookupSubjects(query: SubjectLookup): Promise<SubjectLookupResult> {
    requireSubjectLookupInput(query);
    const permission = this.#policy.permissionName(query.resource.type, query.permission);
    if (permission === undefined) {
      return { subjects: [], hasWildcard: false };
    }
    const compiled = compileSqliteLookupSubjects(this.#policy.model, this.#namespace, this.currentTimeMs(), {
      resource: { type: query.resource.type, id: query.resource.id },
      permission,
      subjectType: query.subjectType,
    });
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

  override async writeRelationships(writes: readonly RelationshipWrite[]): Promise<SpiceDbConsistencyToken> {
    await this.#tuples.write(writes);
    return "";
  }

  override async deleteRelationships(filter: RelationshipFilter): Promise<SpiceDbConsistencyToken> {
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

  override listDirectSubjects(query: DirectSubjectLookup): Promise<readonly SubjectRef[]> {
    return this.#tuples.list(query, this.currentTimeMs());
  }
}
