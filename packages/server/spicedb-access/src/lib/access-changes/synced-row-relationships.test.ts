/**
 * What: a synced-row writer that records the row's relationships in the
 * authorization outbox whenever it writes or deletes the row.
 * Why: a site's copy of a record must carry the same relationships the
 * cloud holds for it, or the site's own graph refuses every read of it.
 */
import { describe, expect, it } from "vitest";

import {
  SYNCED_VALUE_UNKNOWN,
  type SyncedRowChange,
  type SyncedRowWriter,
} from "@dads-framework/postgres";

import { FakeEnqueueAccessChanges } from "../../testing/fake-enqueue.js";
import { InMemoryOwnerLock } from "../../testing/in-memory-owner-lock.js";
import type { RelationshipWrite } from "@dads-framework/access/runtime";
import {
  type SyncedRowRelationships,
  syncedRowWriterWithRelationships,
} from "./synced-row-relationships.js";

type Upsert = Extract<SyncedRowChange<"rows">, { op: "upsert" }>;

/** A stored row: which user holds which role on workspace `plant`, and a label no relationship reads. */
type StoredRow = {
  readonly relation: string;
  readonly userId: string;
  readonly label: string;
};

function roleOf(row: StoredRow): RelationshipWrite {
  return {
    resource: { type: "workspace", id: "plant" },
    relation: row.relation,
    subject: { type: "user", id: row.userId },
  };
}

/** A stand-in transaction: the fake writer and outbox never touch it. */
const TX = "page-transaction";
type Tx = typeof TX;

function fixture() {
  const stored = new Map<string, StoredRow>();
  const writer: SyncedRowWriter<"rows", Tx> = {
    upsert(_tx, change) {
      const next = change.data;
      if (
        typeof next !== "object" ||
        next === null ||
        !("relation" in next) ||
        !("userId" in next) ||
        !("label" in next) ||
        typeof next.relation !== "string" ||
        typeof next.userId !== "string" ||
        typeof next.label !== "string"
      )
        return Promise.resolve(SYNCED_VALUE_UNKNOWN);
      const current = stored.get(change.id);
      if (
        current?.relation === next.relation &&
        current.userId === next.userId &&
        current.label === next.label
      )
        return Promise.resolve(false);
      stored.set(change.id, {
        relation: next.relation,
        userId: next.userId,
        label: next.label,
      });
      return Promise.resolve(true);
    },
    delete(_tx, _table, id) {
      return Promise.resolve(stored.delete(id));
    },
  };
  /** What is still waiting in the outbox: a replaced opposite fact is gone. */
  const waiting = new FakeEnqueueAccessChanges();
  /** Every fact recorded, in order, whatever later replaced it. */
  const outbox = new FakeEnqueueAccessChanges();
  let causes = 0;
  const relationshipsOf = (
    _tx: Tx,
    _table: "rows",
    id: string,
  ): Promise<SyncedRowRelationships | readonly SyncedRowRelationships[]> => {
    const row = stored.get(id);
    if (row === undefined)
      return Promise.resolve({ relationships: [], ownerPartitionId: "plant" });
    // A row in the `elsewhere` slice also carries a fact in another slice.
    if (row.label === "elsewhere")
      return Promise.resolve([
        { relationships: [roleOf(row)], ownerPartitionId: "plant" },
        {
          relationships: [
            {
              resource: { type: "workspace", id: "yard" },
              relation: row.relation,
              subject: { type: "user", id: row.userId },
            },
          ],
          ownerPartitionId: "yard",
        },
      ]);
    return Promise.resolve({
      relationships: [roleOf(row)],
      ownerPartitionId: "plant",
    });
  };
  const withRelationships = syncedRowWriterWithRelationships(
    writer,
    {
      enqueue: (entries) =>
        Promise.all([outbox.enqueue(entries), waiting.enqueue(entries)]).then(
          () => undefined,
        ),
      enqueueReplacingOpposite: (entries, _tx, lease) =>
        Promise.all([
          outbox.enqueue(entries),
          waiting.replaceOpposite(entries, lease),
        ]).then(() => undefined),
    },
    new InMemoryOwnerLock(),
    relationshipsOf,
    () => {
      causes += 1;
      return `cause-${causes}`;
    },
  );
  return { outbox, waiting, writer: withRelationships };
}

function upsert(
  id: string,
  relation: string,
  userId: string,
  label = "Dock",
): Upsert {
  return {
    table: "rows",
    op: "upsert",
    id,
    rowVersion: 1,
    data: { relation, userId, label },
    takeNext: false,
  };
}

function summary(outbox: FakeEnqueueAccessChanges) {
  return outbox.enqueued.map((fact) => [
    fact.operation,
    fact.relationship.relation,
    fact.relationship.subject.id,
    fact.ownerPartitionId,
  ]);
}

describe("syncedRowWriterWithRelationships", () => {
  it("writes the row's relationships when it writes the row", async () => {
    const { writer, outbox } = fixture();

    expect(await writer.upsert(TX, upsert("a", "member", "dana"))).toBe(true);

    expect(summary(outbox)).toEqual([["WRITE", "member", "dana", "plant"]]);
  });

  it("writes nothing new when the same row is applied twice", async () => {
    const { writer, outbox } = fixture();
    await writer.upsert(TX, upsert("a", "member", "dana"));

    expect(await writer.upsert(TX, upsert("a", "member", "dana"))).toBe(false);

    expect(outbox.enqueued).toHaveLength(1);
  });

  it("deletes the old relationship and writes the new one when the row changes", async () => {
    const { writer, outbox } = fixture();
    await writer.upsert(TX, upsert("a", "member", "dana"));

    await writer.upsert(TX, upsert("a", "admin", "dana"));

    expect(summary(outbox)).toEqual([
      ["WRITE", "member", "dana", "plant"],
      ["DELETE", "member", "dana", "plant"],
      ["WRITE", "admin", "dana", "plant"],
    ]);
  });

  it("never deletes a relationship the changed row still carries, and gives each change its own facts", async () => {
    const { writer, outbox } = fixture();
    await writer.upsert(TX, upsert("a", "member", "dana"));

    await writer.upsert(TX, upsert("a", "member", "dana", "Scale house"));

    expect(summary(outbox)).toEqual([
      ["WRITE", "member", "dana", "plant"],
      ["WRITE", "member", "dana", "plant"],
    ]);
    expect(new Set(outbox.enqueued.map((f) => f.idempotencyKey)).size).toBe(2);
  });

  it("removes the row's relationships when it deletes the row, and nothing for a row it never had", async () => {
    const { writer, outbox } = fixture();
    await writer.upsert(TX, upsert("a", "member", "dana"));

    expect(await writer.delete(TX, "rows", "a")).toBe(true);
    expect(await writer.delete(TX, "rows", "never")).toBe(false);

    expect(summary(outbox)).toEqual([
      ["WRITE", "member", "dana", "plant"],
      ["DELETE", "member", "dana", "plant"],
    ]);
  });

  it("records nothing for data the owner cannot read", async () => {
    const { writer, outbox } = fixture();

    expect(
      await writer.upsert(TX, { ...upsert("a", "member", "dana"), data: 7 }),
    ).toBe(SYNCED_VALUE_UNKNOWN);

    expect(outbox.enqueued).toEqual([]);
  });

  it("replaces a grant still waiting for its tuple when the row's change removes it, so the grant can never land after the removal", async () => {
    const { writer, waiting } = fixture();
    await writer.upsert(TX, upsert("a", "member", "dana"));

    await writer.delete(TX, "rows", "a");

    expect(summary(waiting)).toEqual([["DELETE", "member", "dana", "plant"]]);
  });

  it("replaces a removal still waiting for its tuple when the row grants it again", async () => {
    const { writer, waiting } = fixture();
    await writer.upsert(TX, upsert("a", "member", "dana"));
    await writer.upsert(TX, upsert("a", "admin", "dana"));

    await writer.upsert(TX, upsert("a", "member", "dana"));

    expect(summary(waiting)).toEqual([
      ["DELETE", "admin", "dana", "plant"],
      ["WRITE", "member", "dana", "plant"],
    ]);
  });

  it("records each fact in its own authority slice, and removes them all with the row", async () => {
    const { writer, outbox } = fixture();

    await writer.upsert(TX, upsert("a", "member", "dana", "elsewhere"));
    await writer.delete(TX, "rows", "a");

    expect(summary(outbox)).toEqual([
      ["WRITE", "member", "dana", "plant"],
      ["WRITE", "member", "dana", "yard"],
      ["DELETE", "member", "dana", "plant"],
      ["DELETE", "member", "dana", "yard"],
    ]);
  });
});
