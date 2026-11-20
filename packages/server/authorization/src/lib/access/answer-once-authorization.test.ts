import { accessModel } from "@dads-framework/access";
/**
 * What: inside a scope, identical reads reach the vendor once; outside, or
 * after a write, every read reaches it.
 * Why: the decorator sits in front of permission decisions. Answering a read
 * from memory across a write, or outside the request that asked, would hand
 * out authority the graph no longer grants.
 */

import { describe, expect, it } from "vitest";

import { answeringEachQuestionOnce } from "@dads-framework/request-work";
import { measureRequestWork } from "@dads-framework/request-work/testing";

import { AnswerOnceAuthorization } from "@dads-framework/access/runtime";
import {
  Authorization,
  type PermissionCheckOutcome,
  type PermissionQuery,
} from "@dads-framework/access/runtime";
import {
  authorizationKinds,
  DEFAULT_AUTHORIZATION_GUARD_MARKS,
  GuardedAuthorization,
} from "./guarded-authorization.js";
import { TalliedAuthorization } from "./tallied-authorization.js";

class CountingAuthorization extends Authorization {
  checks = 0;
  lookups = 0;
  failNextCheck = false;

  override check(): Promise<boolean> {
    this.checks += 1;
    if (this.failNextCheck) {
      this.failNextCheck = false;
      return Promise.reject(new Error("SpiceDB unavailable"));
    }
    return Promise.resolve(true);
  }
  override lookupResources(): Promise<readonly string[]> {
    this.lookups += 1;
    return Promise.resolve(["workspace-1"]);
  }
  override writeRelationships(): Promise<string> {
    return Promise.resolve("token-write");
  }
  override deleteRelationships(): Promise<string> {
    return Promise.resolve("token-delete");
  }
  override relationshipExists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  override listDirectSubjects(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }
}

const admin = { type: "user", id: "platform-admin" };
const checkQuery = {
  subject: admin,
  permission: "administer",
  resource: { type: "platform", id: "app" },
};
const lookupQuery = {
  subject: admin,
  permission: "view_rail",
  resourceType: "organizations/workspace",
};

describe("AnswerOnceAuthorization", () => {
  it("batches uncached questions and shares their answers with individual checks", async () => {
    const batches: (readonly PermissionQuery[])[] = [];
    const inner = Object.assign(new CountingAuthorization(), {
      checkMany: (queries: readonly PermissionQuery[]) => {
        batches.push(queries);
        return Promise.resolve(
          queries.map((query) => query.permission === "administer"),
        );
      },
    });
    const authorization = new AnswerOnceAuthorization(inner);
    const denied = { ...checkQuery, permission: "view" };

    await answeringEachQuestionOnce(async () => {
      await authorization.check(checkQuery);
      await expect(
        authorization.checkMany([checkQuery, denied, denied]),
      ).resolves.toEqual([true, false, false]);
      await expect(authorization.check(denied)).resolves.toBe(false);
      await expect(authorization.checkMany([denied])).resolves.toEqual([false]);
    });

    expect(batches).toEqual([[denied]]);
    expect(inner.checks).toBe(1);
  });

  it("never answers a fully-consistent question from an earlier answer", async () => {
    const batches: (readonly PermissionQuery[])[] = [];
    const inner = Object.assign(new CountingAuthorization(), {
      checkMany: (queries: readonly PermissionQuery[]) => {
        batches.push(queries);
        return Promise.resolve(queries.map(() => false));
      },
    });
    const authorization = new AnswerOnceAuthorization(inner);
    const current: PermissionQuery = {
      ...checkQuery,
      consistency: "fully-consistent",
    };

    await answeringEachQuestionOnce(async () => {
      await authorization.checkMany([checkQuery]);
      await authorization.checkMany([current]);
    });

    expect(batches).toEqual([[checkQuery], [current]]);
  });

  it("forgets batch answers after relationship writes", async () => {
    let batches = 0;
    const inner = Object.assign(new CountingAuthorization(), {
      checkMany: (queries: readonly PermissionQuery[]) => {
        batches += 1;
        return Promise.resolve(queries.map(() => batches === 1));
      },
    });
    const authorization = new AnswerOnceAuthorization(inner);

    await answeringEachQuestionOnce(async () => {
      await expect(authorization.checkMany([checkQuery])).resolves.toEqual([
        true,
      ]);
      await authorization.writeRelationships([]);
      await expect(authorization.checkMany([checkQuery])).resolves.toEqual([
        false,
      ]);
    });
    expect(batches).toBe(2);
  });

  it("falls back to individual checks for implementations without batching", async () => {
    const inner = new CountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    await expect(
      authorization.checkMany([
        checkQuery,
        { ...checkQuery, permission: "view" },
      ]),
    ).resolves.toEqual([true, true]);
    expect(inner.checks).toBe(2);
  });

  it("retries a failed batch within the request scope", async () => {
    let attempts = 0;
    const failure = new Error("SpiceDB unavailable");
    const inner = Object.assign(new CountingAuthorization(), {
      checkMany: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(failure);
        return Promise.resolve([true]);
      },
    });
    const authorization = new AnswerOnceAuthorization(inner);

    await answeringEachQuestionOnce(async () => {
      await expect(authorization.checkMany([checkQuery])).rejects.toBe(failure);
      await expect(authorization.checkMany([checkQuery])).resolves.toEqual([
        true,
      ]);
    });
    expect(attempts).toBe(2);
  });

  it("asks the vendor once for identical reads in one scope", async () => {
    const inner = new CountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    await answeringEachQuestionOnce(async () => {
      await Promise.all([
        authorization.check(checkQuery),
        authorization.check({ ...checkQuery }),
        authorization.lookupResources(lookupQuery),
        authorization.lookupResources({ ...lookupQuery }),
      ]);
    });
    expect([inner.checks, inner.lookups]).toEqual([1, 1]);
  });

  it("asks again for a different subject, permission, or resource", async () => {
    const inner = new CountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    await answeringEachQuestionOnce(async () => {
      await authorization.check(checkQuery);
      await authorization.check({
        ...checkQuery,
        subject: { type: "user", id: "other" },
      });
      await authorization.check({ ...checkQuery, permission: "view" });
      await authorization.check({
        ...checkQuery,
        resource: { type: "platform", id: "vector" },
      });
    });
    expect(inner.checks).toBe(4);
  });

  it("forwards every read outside a scope and keeps nothing between scopes", async () => {
    const inner = new CountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    await authorization.check(checkQuery);
    await authorization.check(checkQuery);
    await answeringEachQuestionOnce(() => authorization.check(checkQuery));
    await answeringEachQuestionOnce(() => authorization.check(checkQuery));
    expect(inner.checks).toBe(4);
  });

  it.each([
    [
      "writeRelationships",
      (authorization: Authorization) => authorization.writeRelationships([]),
    ],
    [
      "deleteRelationships",
      (authorization: Authorization) =>
        authorization.deleteRelationships({ resourceType: "platform" }),
    ],
  ])("forgets every answer after %s", async (_name, write) => {
    const inner = new CountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    await answeringEachQuestionOnce(async () => {
      await authorization.check(checkQuery);
      await authorization.lookupResources(lookupQuery);
      await write(authorization);
      await authorization.check(checkQuery);
      await authorization.lookupResources(lookupQuery);
    });
    expect([inner.checks, inner.lookups]).toEqual([2, 2]);
  });

  it("counts only real round trips when it sits in front of the tally", async () => {
    const inner = new CountingAuthorization();
    const authorization = new AnswerOnceAuthorization(
      new TalliedAuthorization(inner),
    );
    const tally = await measureRequestWork(() =>
      answeringEachQuestionOnce(async () => {
        await authorization.check(checkQuery);
        await authorization.check(checkQuery);
        await authorization.lookupResources(lookupQuery);
        await authorization.lookupResources(lookupQuery);
      }),
    );
    expect(tally.authzCheckCount).toBe(2);
    expect([inner.checks, inner.lookups]).toEqual([1, 1]);
  });

  it("counts one round trip per bulk batch and none for repeated batch items", async () => {
    let batches = 0;
    const inner = Object.assign(new CountingAuthorization(), {
      checkMany: (queries: readonly PermissionQuery[]) => {
        batches += 1;
        return Promise.resolve(queries.map(() => true));
      },
    });
    const authorization = new AnswerOnceAuthorization(
      new TalliedAuthorization(inner),
    );
    const other = { ...checkQuery, permission: "view" };
    const tally = await measureRequestWork(() =>
      answeringEachQuestionOnce(async () => {
        await authorization.checkMany([checkQuery, other, checkQuery]);
        await authorization.checkMany([other, checkQuery]);
        await authorization.check(checkQuery);
        await authorization.deleteRelationships({ resourceType: "platform" });
        await authorization.checkMany([checkQuery]);
      }),
    );
    expect(batches).toBe(2);
    expect(inner.checks).toBe(0);
    expect(tally.authzCheckCount).toBe(2);
  });

  it("keeps no answer from a read that ran while a write was in flight", async () => {
    const inner = new CountingAuthorization();
    let finishWrite: (token: string) => void = () => undefined;
    inner.writeRelationships = () =>
      new Promise((resolve) => {
        finishWrite = resolve;
      });
    const authorization = new AnswerOnceAuthorization(inner);
    await answeringEachQuestionOnce(async () => {
      const write = authorization.writeRelationships([]);
      await authorization.check(checkQuery);
      finishWrite("token-write");
      await write;
      await authorization.check(checkQuery);
    });
    expect(inner.checks).toBe(2);
  });

  it("asks again after a failed read instead of repeating the failure", async () => {
    const inner = new CountingAuthorization();
    inner.failNextCheck = true;
    const authorization = new AnswerOnceAuthorization(inner);
    await answeringEachQuestionOnce(async () => {
      await expect(authorization.check(checkQuery)).rejects.toThrow(
        "SpiceDB unavailable",
      );
      await expect(authorization.check(checkQuery)).resolves.toBe(true);
    });
    expect(inner.checks).toBe(2);
  });
});

/** A bulk-capable vendor; `answers` returning an Error is that item's error. */
class BulkCountingAuthorization extends CountingAuthorization {
  readonly batches: (readonly PermissionQuery[])[] = [];
  readonly #answers: (query: PermissionQuery) => boolean | Error;
  readonly #failsBatch: (queries: readonly PermissionQuery[]) => boolean;

  constructor(
    answers: (query: PermissionQuery) => boolean | Error = () => true,
    failsBatch: (queries: readonly PermissionQuery[]) => boolean = () => false,
  ) {
    super();
    this.#answers = answers;
    this.#failsBatch = failsBatch;
  }

  override checkEach(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    this.batches.push(queries);
    if (this.#failsBatch(queries)) {
      return Promise.reject(new Error("SpiceDB unavailable"));
    }
    return Promise.resolve(
      queries.map((query): PermissionCheckOutcome => {
        const answer = this.#answers(query);
        return answer instanceof Error
          ? { kind: "failed", error: answer }
          : { kind: "answered", allowed: answer };
      }),
    );
  }
}

const reader = { type: "user", id: "reader" };
const editor = { type: "user", id: "editor" };
const document = (id: string) => ({ type: "test/document", id });
const readerAsks = (permission: string, id: string): PermissionQuery => ({
  subject: reader,
  permission,
  resource: document(id),
});

describe("AnswerOnceAuthorization gathering checks made together", () => {
  it("sends concurrent checks as one round trip", async () => {
    const inner = new BulkCountingAuthorization();
    const authorization = new AnswerOnceAuthorization(
      new TalliedAuthorization(inner),
    );
    const permissions = [
      "administer",
      "execute_live_environment_actions",
      "manage_feature_flags",
      "view_audit_log",
      "manage_staff",
      "view_billing",
      "sign_in_as",
    ];

    const tally = await measureRequestWork(() =>
      answeringEachQuestionOnce(() =>
        Promise.all(
          permissions.map((permission) =>
            authorization.check({ ...checkQuery, permission }),
          ),
        ),
      ),
    );

    expect(inner.batches.map((batch) => batch.length)).toEqual([
      permissions.length,
    ]);
    expect(inner.checks).toBe(0);
    expect(tally.authzCheckCount).toBe(1);
  });

  it("gives each caller its own answer in a batch of mixed subjects and permissions", async () => {
    const inner = new BulkCountingAuthorization(
      (query) =>
        (query.subject.id === "editor" && query.permission === "edit") ||
        (query.subject.id === "reader" && query.resource.id === "open"),
    );
    const authorization = new AnswerOnceAuthorization(inner);
    const questions: PermissionQuery[] = [
      readerAsks("view", "open"),
      readerAsks("view", "closed"),
      { subject: editor, permission: "edit", resource: document("closed") },
      { subject: editor, permission: "view", resource: document("closed") },
      readerAsks("edit", "open"),
      { subject: editor, permission: "edit", resource: document("open") },
    ];

    const answers = await answeringEachQuestionOnce(() =>
      Promise.all(questions.map((query) => authorization.check(query))),
    );

    expect(answers).toEqual([true, false, true, false, true, true]);
    expect(inner.batches).toEqual([questions]);
  });

  it("sends each consistency setting as its own batch", async () => {
    const inner = new BulkCountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    const plainA = readerAsks("view", "a");
    const plainB = readerAsks("view", "b");
    const currentA: PermissionQuery = {
      ...plainA,
      consistency: "fully-consistent",
    };
    const currentB: PermissionQuery = {
      ...plainB,
      consistency: "fully-consistent",
    };
    const pinnedA: PermissionQuery = { ...plainA, consistencyToken: "token-1" };
    const pinnedB: PermissionQuery = { ...plainB, consistencyToken: "token-1" };

    await answeringEachQuestionOnce(() =>
      Promise.all(
        [plainA, currentA, pinnedA, plainB, currentB, pinnedB].map((query) =>
          authorization.check(query),
        ),
      ),
    );

    expect(inner.batches).toEqual([
      [plainA, plainB],
      [currentA, currentB],
      [pinnedA, pinnedB],
    ]);
  });

  it("rejects only the caller whose question SpiceDB answered with an error, as a lone check would", async () => {
    const itemError = new Error("SpiceDB could not answer view");
    const inner = new BulkCountingAuthorization((query) =>
      query.resource.id === "b" ? itemError : query.resource.id === "a",
    );
    const authorization = new AnswerOnceAuthorization(
      new GuardedAuthorization(
        new TalliedAuthorization(inner),
        DEFAULT_AUTHORIZATION_GUARD_MARKS,
        authorizationKinds(accessModel([])),
      ),
    );

    await answeringEachQuestionOnce(async () => {
      const answers = await Promise.allSettled([
        authorization.check(readerAsks("view", "a")),
        authorization.check(readerAsks("view", "b")),
        authorization.check(readerAsks("view", "c")),
      ]);
      expect(answers).toEqual([
        { status: "fulfilled", value: true },
        { status: "rejected", reason: itemError },
        { status: "fulfilled", value: false },
      ]);
      // The failure is not kept: the next ask reaches the vendor again.
      await expect(authorization.check(readerAsks("view", "b"))).resolves.toBe(
        true,
      );
    });

    expect(inner.batches).toHaveLength(1);
    expect(inner.checks).toBe(1);
  });

  it("rejects only the callers whose batch failed", async () => {
    const inner = new BulkCountingAuthorization(
      () => true,
      (queries) =>
        queries.some((query) => query.consistency === "fully-consistent"),
    );
    const authorization = new AnswerOnceAuthorization(inner);
    const plainA = readerAsks("view", "a");
    const plainB = readerAsks("view", "b");

    const answers = await answeringEachQuestionOnce(() =>
      Promise.allSettled([
        authorization.check(plainA),
        authorization.check({ ...plainA, consistency: "fully-consistent" }),
        authorization.check(plainB),
        authorization.check({ ...plainB, consistency: "fully-consistent" }),
      ]),
    );

    expect(answers.map((answer) => answer.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "rejected",
    ]);
    expect(inner.batches).toHaveLength(2);
  });

  it("rejects every caller when the only batch fails, and asks again afterwards", async () => {
    let failing = true;
    const inner = new BulkCountingAuthorization(
      () => true,
      () => failing,
    );
    const authorization = new AnswerOnceAuthorization(inner);
    const questions = [readerAsks("view", "a"), readerAsks("view", "b")];

    await answeringEachQuestionOnce(async () => {
      const failed = await Promise.allSettled(
        questions.map((query) => authorization.check(query)),
      );
      expect(failed.map((answer) => answer.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      failing = false;
      await expect(
        Promise.all(questions.map((query) => authorization.check(query))),
      ).resolves.toEqual([true, true]);
    });

    expect(inner.batches).toEqual([questions, questions]);
  });

  it("answers a cached question from memory and batches only the misses", async () => {
    const inner = new BulkCountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    const known = readerAsks("view", "a");
    const misses = [readerAsks("view", "b"), readerAsks("view", "c")];

    await answeringEachQuestionOnce(async () => {
      await authorization.check(known);
      await Promise.all(
        [known, ...misses].map((query) => authorization.check(query)),
      );
    });

    expect(inner.checks).toBe(1);
    expect(inner.batches).toEqual([misses]);
  });

  it("sends a question asked twice in one tick as one item", async () => {
    const inner = new BulkCountingAuthorization(
      (query) => query.resource.id === "a",
    );
    const authorization = new AnswerOnceAuthorization(inner);

    const answers = await answeringEachQuestionOnce(() =>
      Promise.all([
        authorization.check(readerAsks("view", "a")),
        authorization.check(readerAsks("view", "b")),
        authorization.check(readerAsks("view", "a")),
      ]),
    );

    expect(answers).toEqual([true, false, true]);
    expect(inner.batches).toEqual([
      [readerAsks("view", "a"), readerAsks("view", "b")],
    ]);
  });

  it("keeps the plain check for checks awaited one after another", async () => {
    const inner = new BulkCountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);

    await answeringEachQuestionOnce(async () => {
      await authorization.check(readerAsks("view", "a"));
      await authorization.check(readerAsks("view", "b"));
    });

    expect(inner.checks).toBe(2);
    expect(inner.batches).toEqual([]);
  });

  it("splits more than 128 concurrent checks into bulk calls of 128", async () => {
    const inner = new BulkCountingAuthorization(
      (query) => Number(query.resource.id) % 2 === 0,
    );
    const authorization = new AnswerOnceAuthorization(
      new TalliedAuthorization(inner),
    );
    const questions = Array.from({ length: 130 }, (_, index) =>
      readerAsks("view", String(index)),
    );

    let answers: readonly boolean[] = [];
    const tally = await measureRequestWork(async () => {
      answers = await answeringEachQuestionOnce(() =>
        Promise.all(questions.map((query) => authorization.check(query))),
      );
    });

    expect(answers).toEqual(questions.map((_, index) => index % 2 === 0));
    expect(inner.batches.map((batch) => batch.length)).toEqual([128, 2]);
    expect(tally.authzCheckCount).toBe(2);
  });

  it("never sends two requests' checks together", async () => {
    const inner = new BulkCountingAuthorization();
    const authorization = new AnswerOnceAuthorization(inner);
    const oneRequest = (id: string) =>
      answeringEachQuestionOnce(() =>
        Promise.all([
          authorization.check(readerAsks("view", id)),
          authorization.check(readerAsks("edit", id)),
        ]),
      );

    await Promise.all([oneRequest("a"), oneRequest("b")]);

    expect(inner.batches).toEqual([
      [readerAsks("view", "a"), readerAsks("edit", "a")],
      [readerAsks("view", "b"), readerAsks("edit", "b")],
    ]);
  });

  it("checks one by one outside a scope or without bulk checks", async () => {
    const bulk = new BulkCountingAuthorization();
    const single = new CountingAuthorization();
    const questions = [readerAsks("view", "a"), readerAsks("view", "b")];
    const outsideScope = new AnswerOnceAuthorization(bulk);
    const withoutBulk = new AnswerOnceAuthorization(single);

    await Promise.all(questions.map((query) => outsideScope.check(query)));
    await answeringEachQuestionOnce(() =>
      Promise.all(questions.map((query) => withoutBulk.check(query))),
    );

    expect([bulk.checks, bulk.batches.length]).toEqual([2, 0]);
    expect(single.checks).toBe(2);
  });
});
