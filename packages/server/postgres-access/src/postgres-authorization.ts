import type { DslPermissionTarget, PermissionToken } from "@dads-framework/access";
import {
  Authorization,
  permissionQueryFromCan,
  type AccessChange,
  type AuthorizationCanOptions,
  type DirectSubjectLookup,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipWrite,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectLookup,
  type SubjectLookupResult,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import { type PostgresQuery, type PostgresRow } from "./postgres-types.js";
import {
  compilePostgresCheck,
  compilePostgresCheckMany,
  compilePostgresLookup,
} from "./policy/compile-postgres-policy.js";
import type { PostgresFilterQuery, PostgresAccessFilter } from "./policy/compile-filter.js";
import { verifyPostgresColumnRelations, type ColumnRelationCheckResult } from "./policy/column-relations.js";
import { runCompilePostgresFilter, runResolvePostgresFilter } from "./policy/run-filter.js";
import { compileLinearCheck } from "./policy/compile-linear-check.js";
import { compilePostgresSubjectLookup } from "./policy/compile-subject-lookup.js";
import type { NormalizedPermissionCheck } from "./policy/policy-model.js";

import { compileAccessPolicy, type CompiledAccessPolicy } from "./compile-access-policy.js";
import { isDrizzlePgTransaction, type DrizzleExecuteLike } from "./drizzle-structural.js";
import {
  parseSubjectLookupRows,
  readDecisionFlag,
  readTupleColumn,
  requireConcreteSubject,
  requireSubjectLookupInput,
} from "./postgres-response.js";
import {
  lazyDrizzleTransactionExecutor,
  validatePostgresAccessOptions,
  type PostgresAccessExecutor,
  type PostgresAccessOptions,
} from "./postgres-options.js";
import { PostgresTuples } from "./postgres-tuples.js";
import { assertProtectedAuthorizationActive } from "./protected-authorization-scope.js";
import { RevisionedLookup } from "./revisioned-lookup.js";
import { readFromLookupPrimary } from "./lookup-primary-pool.js";

export type { PostgresAccessExecutor, PostgresAccessOptions };

const CHECK_BATCH_SIZE = 2_048;

/** Experimental authorization over the application's primary Postgres database. */
export class PostgresAuthorization extends Authorization {
  readonly #executor: PostgresAccessExecutor;
  readonly #policy: CompiledAccessPolicy;
  readonly #options: PostgresAccessOptions;
  readonly #tuples: PostgresTuples;
  readonly #revisionedLookup: RevisionedLookup | undefined;

  constructor(options: PostgresAccessOptions) {
    super();
    const timeout = validatePostgresAccessOptions(options);
    this.#options = Object.freeze({ ...options });
    this.#executor = options.executor;
    const reusePool = options.reuseLookupResultsOn;
    this.#revisionedLookup =
      reusePool === undefined
        ? undefined
        : new RevisionedLookup(options.namespace, (query) => readFromLookupPrimary(reusePool, query, timeout));
    this.#policy = compileAccessPolicy(options.model, options.columnRelations);
    this.#tuples = new PostgresTuples(this.#policy.model, options.namespace, (query) => this.#query(query));
  }

  /** Bind every operation to an application-owned transaction client. */
  inTransaction(executor: PostgresAccessExecutor): PostgresAuthorization {
    assertProtectedAuthorizationActive(this);
    const { model, namespace, queryTimeoutMs, columnRelations } = this.#options;
    return new PostgresAuthorization({
      model,
      namespace,
      executor,
      ...(queryTimeoutMs === undefined ? {} : { queryTimeoutMs }),
      ...(columnRelations === undefined ? {} : { columnRelations }),
    });
  }

  /**
   * Verify every configured `columnRelations` table and column exists in
   * PostgreSQL and report whether the recommended reverse-lookup index exists.
   */
  verifyColumnRelations(): Promise<readonly ColumnRelationCheckResult[]> {
    return verifyPostgresColumnRelations(this.#policy.model.columnRelations ?? [], (query) => this.#query(query));
  }

  /** Bind reads and writes to an existing Drizzle transaction. */
  inDrizzleTransaction(transaction: DrizzleExecuteLike): PostgresAuthorization {
    if (!isDrizzlePgTransaction(transaction)) {
      throw new Error("Postgres authorization requires a Drizzle transaction");
    }
    return this.inTransaction(lazyDrizzleTransactionExecutor(transaction));
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
    const normalized = this.#normalizedCheck(query);
    if (normalized === undefined) return false;
    const linear = this.#executor.queryCheck
      ? compileLinearCheck(this.#policy.model, this.#options.namespace, normalized)
      : undefined;
    if (linear === undefined) return this.#ordinaryCheck(normalized);

    const timeout = this.#options.queryTimeoutMs ?? 5_000;
    const deadline = performance.now() + timeout;
    const rows = await this.#query(linear, "check", timeout);
    const row = rows[0];
    if (row?.["allowed"] !== null) return readDecisionFlag(row);

    // The bounded scan gave no decision. Only this complete read determines
    // the answer, in the executor's own transaction and remaining deadline.
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error("Query read timeout");
    return this.#ordinaryCheck(normalized, remaining);
  }

  async #ordinaryCheck(normalized: NormalizedPermissionCheck, timeout?: number): Promise<boolean> {
    const query = compilePostgresCheck(this.#policy.model, this.#options.namespace, normalized);
    const rows = await this.#query(query, timeout === undefined && query.canPrepare ? "check" : undefined, timeout);
    return readDecisionFlag(rows[0]);
  }

  override async checkMany(queries: readonly PermissionQuery[]): Promise<readonly boolean[]> {
    const answers: boolean[] = [];
    for (let offset = 0; offset < queries.length; offset += CHECK_BATCH_SIZE) {
      answers.push(...(await this.#checkBatch(queries.slice(offset, offset + CHECK_BATCH_SIZE))));
    }
    return answers;
  }

  async #checkBatch(queries: readonly PermissionQuery[]): Promise<readonly boolean[]> {
    const normalized = queries.map((query) => this.#normalizedCheck(query));
    const known = normalized.filter((query) => query !== undefined);
    if (known.length === 0) return normalized.map(() => false);
    const compiled = compilePostgresCheckMany(this.#policy.model, this.#options.namespace, known);
    const rows = await this.#query(compiled, compiled.canPrepare ? "check" : undefined);
    if (rows.length !== known.length) throw new Error("Postgres authorization omitted a decision");
    let index = 0;
    return normalized.map((query) => (query === undefined ? false : readDecisionFlag(rows[index++])));
  }

  #normalizedCheck(query: PermissionQuery): NormalizedPermissionCheck | undefined {
    requireConcreteSubject(query.subject);
    const permission = this.#policy.permissionName(query.resource.type, query.permission);
    if (permission === undefined) return undefined;
    return { subject: query.subject, resource: query.resource, permission };
  }

  /** Compile a parameterized SQL Boolean filter predicate for single-query resource listing. */
  compileFilter(query: PostgresFilterQuery): PostgresAccessFilter {
    return runCompilePostgresFilter(this.#policy, this.#options.namespace, query);
  }

  /** Resolves a `scopeColumns`-assisted filter, pruning empty branches for optimal SQL plans. */
  resolveFilter(query: PostgresFilterQuery): Promise<PostgresAccessFilter> {
    return runResolvePostgresFilter(this.#policy, this.#options.namespace, query, (planQuery) =>
      this.#query(planQuery, "check"),
    );
  }

  override async lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    requireConcreteSubject(query.subject);
    const permission = this.#policy.permissionName(query.resourceType, query.permission);
    if (permission === undefined) return [];
    const input = { ...query, subject: { ...query.subject }, permission };
    const compile = () => compilePostgresLookup(this.#policy.model, this.#options.namespace, input);
    if (this.#revisionedLookup !== undefined) return this.#revisionedLookup.lookup(input, compile);
    const rows = await this.#query(compile());
    return rows.map((row) => readTupleColumn(row, "resource_id"));
  }

  override async lookupSubjects(query: SubjectLookup): Promise<SubjectLookupResult> {
    requireSubjectLookupInput(query);
    const permission = this.#policy.permissionName(query.resource.type, query.permission);
    if (permission === undefined) return { subjects: [], hasWildcard: false };
    const compiled = compilePostgresSubjectLookup(this.#policy.model, this.#options.namespace, {
      resource: query.resource,
      permission,
      subjectType: query.subjectType,
    });
    const rows = await this.#query(compiled);
    return parseSubjectLookupRows(rows);
  }

  /** Apply exact facts to this executor. Bind to the caller's transaction first. */
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

  override relationshipExists(
    filter: Required<Pick<RelationshipFilter, "resourceType" | "resourceId" | "relation">>,
  ): Promise<boolean> {
    return this.#tuples.exists(filter);
  }

  override listDirectSubjects(query: DirectSubjectLookup): Promise<readonly SubjectRef[]> {
    return this.#tuples.list(query);
  }

  async #query(
    query: PostgresQuery,
    operation?: "check",
    timeout = this.#options.queryTimeoutMs ?? 5_000,
  ): Promise<readonly PostgresRow[]> {
    const config = {
      ...query,
      query_timeout: timeout,
    };
    const executor = this.#executor;
    const result =
      operation === "check" && executor.queryCheck ? await executor.queryCheck(config) : await executor.query(config);
    return result.rows;
  }
}
