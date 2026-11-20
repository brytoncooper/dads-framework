import type {
  DrizzleHandle,
  PostgresConnection,
} from "@dads-framework/postgres";
import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { AccessModel } from "@dads-framework/access";
import {
  Authorization,
  type AccessChange,
  type DirectSubjectLookup,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipWrite,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import {
  type PostgresQuery,
  type PostgresRow,
  type PostgresQueryResult,
} from "./postgres-types.js";
import {
  compilePostgresCheck,
  compilePostgresCheckMany,
  compilePostgresLookup,
} from "./policy/compile-postgres-policy.js";
import { compileLinearCheck } from "./policy/compile-linear-check.js";
import type { NormalizedPermissionCheck } from "./policy/policy-model.js";

import {
  compileAccessPolicy,
  type CompiledAccessPolicy,
} from "./compile-access-policy.js";
import { transactionExecutor } from "./drizzle-executor.js";
import { readDecisionFlag, readTupleColumn } from "./postgres-response.js";
import { PostgresTuples } from "./postgres-tuples.js";
import { RevisionedLookup } from "./revisioned-lookup.js";
import { readFromLookupPrimary } from "./lookup-primary-pool.js";
import { isPreparedCheckExecutorForPool } from "./prepared-check-executor.js";

const CHECK_BATCH_SIZE = 128;

export type PostgresAccessExecutor = {
  query(query: PostgresQuery): PromiseLike<PostgresQueryResult>;
  queryCheck?(query: PostgresQuery): PromiseLike<PostgresQueryResult>;
};

export type PostgresAccessOptions = {
  readonly model: AccessModel;
  readonly namespace: string;
  readonly executor: PostgresAccessExecutor;
  readonly queryTimeoutMs?: number;
  /** The same managed, primary autocommit pool passed as executor. Requires the optional revision migration. */
  readonly reuseLookupResultsOn?: PostgresConnection["pool"];
};

/** Experimental authorization over the application's primary Postgres database. */
export class PostgresAuthorization extends Authorization {
  readonly #executor: PostgresAccessExecutor;
  readonly #policy: CompiledAccessPolicy;
  readonly #options: PostgresAccessOptions;
  readonly #tuples: PostgresTuples;
  readonly #revisionedLookup: RevisionedLookup | undefined;

  constructor(options: PostgresAccessOptions) {
    super();
    if (options.namespace.trim() === "")
      throw new Error("Postgres authorization namespace is required");
    const timeout = options.queryTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1)
      throw new Error(
        "Postgres authorization queryTimeoutMs must be a positive integer",
      );
    this.#options = Object.freeze({ ...options });
    this.#executor = options.executor;
    const reusePool = options.reuseLookupResultsOn;
    if (
      reusePool !== undefined &&
      (typeof reusePool.connect !== "function" ||
        (reusePool !== options.executor &&
          !isPreparedCheckExecutorForPool(reusePool, options.executor)))
    ) {
      throw new Error(
        "Postgres lookup reuse requires the same primary pool as the executor",
      );
    }
    this.#revisionedLookup =
      reusePool === undefined
        ? undefined
        : new RevisionedLookup(options.namespace, (query) =>
            readFromLookupPrimary(reusePool, query, timeout),
          );
    this.#policy = compileAccessPolicy(options.model);
    this.#tuples = new PostgresTuples(
      this.#policy.model,
      options.namespace,
      (query) => this.#query(query),
    );
  }

  /** Bind every operation to an application-owned transaction client. */
  inTransaction(executor: PostgresAccessExecutor): PostgresAuthorization {
    const { model, namespace, queryTimeoutMs } = this.#options;
    return new PostgresAuthorization({
      model,
      namespace,
      executor,
      ...(queryTimeoutMs === undefined ? {} : { queryTimeoutMs }),
    });
  }

  /** Bind reads and writes to an existing Drizzle transaction. */
  inDrizzleTransaction(
    transaction: Pick<DrizzleHandle, "execute">,
  ): PostgresAuthorization {
    if (!is(transaction, PgTransaction)) {
      throw new Error("Postgres authorization requires a Drizzle transaction");
    }
    return this.inTransaction(transactionExecutor(transaction));
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    const normalized = this.#normalizedCheck(query);
    if (normalized === undefined) return false;
    const linear = this.#executor.queryCheck
      ? compileLinearCheck(
          this.#policy.model,
          this.#options.namespace,
          normalized,
        )
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

  async #ordinaryCheck(
    normalized: NormalizedPermissionCheck,
    timeout?: number,
  ): Promise<boolean> {
    const query = compilePostgresCheck(
      this.#policy.model,
      this.#options.namespace,
      normalized,
    );
    const rows = await this.#query(
      query,
      timeout === undefined && query.canPrepare ? "check" : undefined,
      timeout,
    );
    return readDecisionFlag(rows[0]);
  }

  override async checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    const answers: boolean[] = [];
    for (let offset = 0; offset < queries.length; offset += CHECK_BATCH_SIZE) {
      answers.push(
        ...(await this.#checkBatch(
          queries.slice(offset, offset + CHECK_BATCH_SIZE),
        )),
      );
    }
    return answers;
  }

  async #checkBatch(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    const normalized = queries.map((query) => this.#normalizedCheck(query));
    const known = normalized.filter((query) => query !== undefined);
    if (known.length === 0) return normalized.map(() => false);
    const rows = await this.#query(
      compilePostgresCheckMany(
        this.#policy.model,
        this.#options.namespace,
        known,
      ),
    );
    if (rows.length !== known.length)
      throw new Error("Postgres authorization omitted a decision");
    let index = 0;
    return normalized.map((query) =>
      query === undefined ? false : readDecisionFlag(rows[index++]),
    );
  }

  #normalizedCheck(
    query: PermissionQuery,
  ): NormalizedPermissionCheck | undefined {
    requireConcreteSubject(query.subject);
    const permission = this.#policy.permissionName(
      query.resource.type,
      query.permission,
    );
    if (permission === undefined) return undefined;
    return { subject: query.subject, resource: query.resource, permission };
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
    const input = { ...query, subject: { ...query.subject }, permission };
    const compile = () =>
      compilePostgresLookup(this.#policy.model, this.#options.namespace, input);
    if (this.#revisionedLookup !== undefined)
      return this.#revisionedLookup.lookup(input, compile);
    const rows = await this.#query(compile());
    return rows.map((row) => readTupleColumn(row, "resource_id"));
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

  override relationshipExists(
    filter: Required<
      Pick<RelationshipFilter, "resourceType" | "resourceId" | "relation">
    >,
  ): Promise<boolean> {
    return this.#tuples.exists(filter);
  }

  override listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
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
      operation === "check" && executor.queryCheck
        ? await executor.queryCheck(config)
        : await executor.query(config);
    return result.rows;
  }
}

function requireConcreteSubject(subject: SubjectRef): void {
  if (
    subject.id.length === 0 ||
    subject.id === "*" ||
    subject.relation !== undefined
  ) {
    throw new Error("Postgres authorization reads require a concrete subject");
  }
}
