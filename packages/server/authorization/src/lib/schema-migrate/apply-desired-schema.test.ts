// Apply deletes leftover tuples then WriteSchema so a contraction does not
// require wiping the graph. Permission-only edits still write.
import { describe, expect, it } from "vitest";
import type { RelationshipFilter } from "@dads-framework/access/runtime";
import { applyDesiredAuthorizationSchema } from "@dads-framework/access/schema";
import type { AuthorizationSchemaStore } from "@dads-framework/access/schema";

const LIVE = `
definition user {}
definition docs/note {
  relation owner: user
  relation stale: user
  permission view = owner + stale
}
`;

const DESIRED = `
definition user {}
definition docs/note {
  relation owner: user
  permission view = owner
}
`;

describe("applyDesiredAuthorizationSchema", () => {
  it("writes the desired schema when live is empty", async () => {
    const store = fakeStore("");

    const report = await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED,
    });

    expect(store.deletes).toEqual([]);
    expect(store.writes).toEqual([DESIRED]);
    expect(report.wroteSchema).toBe(true);
    expect(report.snapshot).toBe("not-needed");
  });

  it("skips the rolling clone when contracting without a datastore URL", async () => {
    const store = fakeStore(LIVE);

    const report = await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED,
    });

    expect(report.snapshot).toBe("skipped");
    expect(store.writes).toEqual([DESIRED]);
  });

  it("deletes leftover relations then writes the desired schema", async () => {
    const store = fakeStore(LIVE);
    let snapshotCalls = 0;

    const report = await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED,
      snapshotDatastore: () => {
        snapshotCalls += 1;
        return Promise.resolve("cloned");
      },
    });

    expect(store.deletes).toEqual([
      { resourceType: "docs/note", relation: "stale" },
    ]);
    expect(store.writes).toEqual([DESIRED]);
    expect(report.removedRelations).toEqual([
      { resourceType: "docs/note", relation: "stale" },
    ]);
    expect(snapshotCalls).toBe(1);
    expect(report.snapshot).toBe("cloned");
  });

  it("retries WriteSchema after deleting a named leftover filter", async () => {
    const store = fakeStore(DESIRED, [
      new Error(
        "cannot delete relation `stale` in object definition `docs/note`, as a relationship exists under it",
      ),
    ]);

    await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED,
    });

    expect(store.deletes).toEqual([
      { resourceType: "docs/note", relation: "stale" },
    ]);
    expect(store.writeAttempts).toBe(2);
    expect(store.writes).toEqual([DESIRED]);
  });

  it("writes again when live already matches so permission formulas update", async () => {
    const store = fakeStore(DESIRED);

    const report = await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED,
      snapshotDatastore: () => Promise.resolve("cloned"),
    });

    expect(store.deletes).toEqual([]);
    expect(store.writes).toEqual([DESIRED]);
    expect(report.snapshot).toBe("not-needed");
  });

  it("fails closed on an unrelated WriteSchema error", async () => {
    const store = fakeStore("", [new Error("connection refused")]);

    await expect(
      applyDesiredAuthorizationSchema({
        store,
        desiredSchema: DESIRED,
      }),
    ).rejects.toThrow(/connection refused/);
  });
});

function fakeStore(
  initialSchema: string,
  writeFailures: readonly Error[] = [],
): AuthorizationSchemaStore & {
  deletes: RelationshipFilter[];
  writes: string[];
  writeAttempts: number;
} {
  const remainingFailures = [...writeFailures];
  const deletes: RelationshipFilter[] = [];
  const writes: string[] = [];
  let schema = initialSchema;
  const store = {
    deletes,
    writes,
    writeAttempts: 0,
    readSchema() {
      return Promise.resolve(schema);
    },
    writeSchema(next: string) {
      store.writeAttempts += 1;
      const failure = remainingFailures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      schema = next;
      writes.push(next);
      return Promise.resolve();
    },
    deleteRelationships(filter: RelationshipFilter) {
      deletes.push(filter);
      return Promise.resolve();
    },
  };
  return store;
}
