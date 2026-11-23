/**
 * What: stating the relationships of rows a copy already holds.
 * Why: a site that copied rows before its build recorded relationships
 * with each write must still get them once, through the same supersede
 * path as every other write, or those rows stay unreadable at the site.
 */
import { describe, expect, it } from "vitest";

import { FakeEnqueueAccessChanges } from "../../testing/fake-enqueue.js";
import { InMemoryOwnerLock } from "../../testing/in-memory-owner-lock.js";
import type { RelationshipWrite } from "@dads-framework/access/runtime";
import { outboxKeyForRelationship } from "./enqueue.js";
import { stateSyncedRowRelationships } from "./synced-row-relationships.js";

const TX = "page-transaction";

function memberOf(workspace: string, userId: string): RelationshipWrite {
  return {
    resource: { type: "workspace", id: workspace },
    relation: "member",
    subject: { type: "user", id: userId },
  };
}

/** Row id → the workspace it places its user at. */
const STORED = new Map([
  ["dana", "plant"],
  ["sam", "yard"],
]);

function state(waiting: FakeEnqueueAccessChanges, ids: readonly string[]) {
  let causes = 0;
  return stateSyncedRowRelationships(
    {
      tx: TX,
      table: "rows",
      ids,
      outbox: {
        enqueue: (entries) => waiting.enqueue(entries),
        enqueueReplacingOpposite: (entries, _tx, lease) => waiting.replaceOpposite(entries, lease),
      },
      partitions: new InMemoryOwnerLock(),
      relationshipsOf: (_tx, _table, id) => {
        const workspace = STORED.get(id);
        return Promise.resolve({
          relationships: workspace === undefined ? [] : [memberOf(workspace, id)],
          ownerPartitionId: workspace ?? null,
        });
      },
    },
    () => {
      causes += 1;
      return `backfill-${causes}`;
    },
  );
}

describe("stateSyncedRowRelationships", () => {
  it("writes each held row's relationships under its own slice, and nothing for a row no longer stored", async () => {
    const waiting = new FakeEnqueueAccessChanges();

    const recorded = await state(waiting, ["dana", "sam", "gone"]);

    expect(recorded).toBe(2);
    expect(
      waiting.enqueued.map((fact) => [fact.operation, fact.relationship.resource.id, fact.ownerPartitionId]),
    ).toEqual([
      ["WRITE", "plant", "plant"],
      ["WRITE", "yard", "yard"],
    ]);
  });

  it("replaces a waiting removal of the same tuple, as the copy's own writes do", async () => {
    const waiting = new FakeEnqueueAccessChanges();
    const removal = memberOf("plant", "dana");
    await waiting.enqueue([
      {
        idempotencyKey: outboxKeyForRelationship("DELETE", removal, "older"),
        operation: "DELETE",
        relationship: removal,
        ownerPartitionId: "plant",
      },
    ]);

    await state(waiting, ["dana"]);

    expect(waiting.enqueued.map((fact) => fact.operation)).toEqual(["WRITE"]);
  });
});
