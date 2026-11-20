/**
 * The authorization port, answering each identical read once per scope.
 *
 * A route that checks access at the edge and again in its handler, or a
 * projection that asks the same question for every company it lists, like
 * the launcher a platform administrator sees, otherwise pays one SpiceDB
 * round trip per repeat. Inside `answeringEachQuestionOnce` — the HTTP kit
 * opens one per request — a repeated `check`, batch item or
 * `lookupResources` shares the first answer. The scope lives for one
 * request, and any write through this port forgets every answer, so the
 * request still sees its own grants and revocations. Outside a scope every
 * call forwards.
 *
 * Inside a scope, single `check` calls that miss in the same tick — a
 * `Promise.all` of checks, say — also travel together: they are gathered,
 * grouped by `consistency` and `consistencyToken`, and sent as one
 * `checkEach` per group (at most 128 questions each), so the tally counts
 * one round trip per group. A tick with one miss in a group sends a plain
 * `check`, as before. Each caller gets its own answer, and fails exactly as
 * a lone `check` would: a group whose call fails rejects only its own
 * callers, and a question SpiceDB answers with an item error rejects only
 * that question's caller. Without `checkEach` behind it, checks go one by one.
 */

import {
  AnswersOncePerScope,
  OneValuePerScope,
} from "@dads-framework/request-work";

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
  type SubjectRef,
} from "./authorization.js";
import {
  lookupQuestionIdentity,
  permissionQuestionIdentity,
} from "./question-identity.js";

const PERMISSION_BATCH_SIZE = 128;

/** Single checks one scope has gathered this tick, not yet sent. */
type GatheredChecks = {
  readonly queries: PermissionQuery[];
  readonly outcomes: Promise<readonly PermissionCheckOutcome[]>;
};

export class AnswerOnceAuthorization extends Authorization {
  readonly #inner: Authorization;
  readonly #checks = new AnswersOncePerScope<boolean>();
  readonly #lookups = new AnswersOncePerScope<readonly string[]>();
  /** This tick's gathered checks in the current scope, by consistency group. */
  readonly #gathering = new OneValuePerScope<Map<string, GatheredChecks>>();

  constructor(inner: Authorization) {
    super();
    this.#inner = inner;
  }

  override check(query: PermissionQuery): Promise<boolean> {
    return this.#checks.answer(checkKey(query), () =>
      this.#gathering.inScope() && this.#inner.checkEach !== undefined
        ? this.#gatherCheck(query)
        : this.#inner.check(query),
    );
  }

  /** Joins this tick's group for the query's consistency; its index is its answer. */
  #gatherCheck(query: PermissionQuery): Promise<boolean> {
    const groupKey = consistencyKey(query);
    const groups = this.#gathering.get() ?? this.#startGathering();
    const group = groups.get(groupKey) ?? this.#openGroup(groups, groupKey);
    const index = group.queries.length;
    group.queries.push(query);
    if (group.queries.length === PERMISSION_BATCH_SIZE) groups.delete(groupKey);
    return group.outcomes.then((outcomes) => {
      const outcome = outcomes[index];
      if (outcome === undefined) {
        throw new Error("a gathered permission check came back unanswered");
      }
      // An item error rejects its caller, exactly as a lone check throws.
      if (outcome.kind === "failed") throw outcome.error;
      return outcome.allowed;
    });
  }

  #startGathering(): Map<string, GatheredChecks> {
    const groups = new Map<string, GatheredChecks>();
    this.#gathering.set(groups);
    return groups;
  }

  /** A group sends once the tick that opened it has finished gathering. */
  #openGroup(
    groups: Map<string, GatheredChecks>,
    groupKey: string,
  ): GatheredChecks {
    const queries: PermissionQuery[] = [];
    const outcomes = Promise.resolve().then(() => {
      if (groups.get(groupKey) === group) groups.delete(groupKey);
      return this.#sendGathered(queries);
    });
    const group: GatheredChecks = { queries, outcomes };
    groups.set(groupKey, group);
    return group;
  }

  #sendGathered(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    const checkEach = this.#inner.checkEach?.bind(this.#inner);
    if (checkEach === undefined || queries.length === 1) {
      return Promise.all(
        queries.map((query) => checkOutcome(() => this.#inner.check(query))),
      );
    }
    return checkEach(queries);
  }

  override async checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    const decisions: boolean[] = [];
    for (
      let offset = 0;
      offset < queries.length;
      offset += PERMISSION_BATCH_SIZE
    ) {
      decisions.push(
        ...(await this.#checkBatch(
          queries.slice(offset, offset + PERMISSION_BATCH_SIZE),
        )),
      );
    }
    return decisions;
  }

  #checkBatch(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    const uncached: PermissionQuery[] = [];
    // Cache misses register synchronously before the batch starts in this microtask.
    const batch = Promise.resolve().then(async () => {
      if (uncached.length === 0) return [];
      if (this.#inner.checkMany !== undefined) {
        return this.#inner.checkMany(uncached);
      }
      const decisions: boolean[] = [];
      for (const query of uncached)
        decisions.push(await this.#inner.check(query));
      return decisions;
    });
    const answers: Promise<boolean>[] = [];
    for (const query of queries) {
      answers.push(
        this.#checks.answer(checkKey(query), () => {
          const index = uncached.length;
          uncached.push(query);
          return batch.then((decisions) => decisions[index] === true);
        }),
      );
    }
    return Promise.all(answers);
  }

  override lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    return this.#lookups.answer(lookupKey(query), () =>
      this.#inner.lookupResources(query),
    );
  }

  override writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    return this.#forgettingAround(() => this.#inner.writeRelationships(writes));
  }

  override deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    return this.#forgettingAround(() =>
      this.#inner.deleteRelationships(filter),
    );
  }

  override relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    return this.#inner.relationshipExists(filter);
  }

  override listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    return this.#inner.listDirectSubjects(query);
  }

  /**
   * Forgets before the write and again once it settles, so a read that ran
   * while the write was in flight cannot leave a pre-write answer behind.
   */
  async #forgettingAround<T>(write: () => Promise<T>): Promise<T> {
    this.#forgetAnswers();
    try {
      return await write();
    } finally {
      this.#forgetAnswers();
    }
  }

  #forgetAnswers(): void {
    this.#checks.forget();
    this.#lookups.forget();
  }
}

function checkKey(query: PermissionQuery): string {
  return JSON.stringify([
    ...permissionQuestionIdentity(query),
    query.consistencyToken ?? null,
    // A fully-consistent ask never takes an earlier, possibly cached, answer.
    query.consistency ?? null,
  ]);
}

/** Questions that may share one bulk call: the same consistency asked. */
function consistencyKey(query: PermissionQuery): string {
  return JSON.stringify([
    query.consistencyToken ?? null,
    query.consistency ?? null,
  ]);
}

function lookupKey(query: ResourceLookup): string {
  return JSON.stringify([
    ...lookupQuestionIdentity(query),
    query.consistencyToken ?? null,
  ]);
}
