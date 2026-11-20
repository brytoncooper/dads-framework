import type { SyncedRowWriter } from "@dads-framework/postgres";
import { mintUuidV7 } from "@dads-framework/contract";

import type { RelationshipWrite } from "@dads-framework/access/runtime";
import { type AccessChange, outboxKeyForRelationship } from "./enqueue.js";
import type { OwnerLock, OwnerLockLease } from "@dads-framework/access/runtime";

/** The relationships a stored row carries, and the authority slice they belong to. */
export type SyncedRowRelationships = {
  readonly relationships: readonly RelationshipWrite[];
  readonly ownerPartitionId: string | null;
};

/**
 * Reads one stored row of the copy and answers its relationships, built by
 * the owning domain's own fact builders: empty when the row is absent or
 * carries none. A row whose removal takes other rows' access with it (a
 * deleted workspace and its records) answers one group per authority
 * slice.
 */
export type ReadSyncedRowRelationships<Table extends string, Tx> = (
  tx: Tx,
  table: Table,
  id: string,
) => Promise<SyncedRowRelationships | readonly SyncedRowRelationships[]>;

/** The outbox a copy records into: plain facts, and facts that replace a waiting opposite. */
export type SyncedRowOutbox<Tx> = {
  enqueue(entries: readonly AccessChange[], tx: Tx): Promise<void>;
  enqueueReplacingOpposite(
    entries: readonly AccessChange[],
    tx: Tx,
    lease: OwnerLockLease,
  ): Promise<void>;
};

/**
 * Wraps a copy's row writer so each row it writes or deletes records the
 * row's relationships in the authorization outbox, in the same transaction:
 * the relationships the row carried before and no longer does are deleted,
 * and every one it carries now is written (SpiceDB TOUCHes it, so a tuple
 * already there stays). A row the writer left alone (the same row applied
 * twice) records nothing.
 *
 * Each fact replaces the waiting opposite fact for its exact tuple, under
 * that tuple's authority-slice lock, as the cloud's own writers do: a grant
 * that has not reached the graph yet can never land after the removal that
 * followed it. Each change mints its own cause, because a row moves
 * add → remove → add and a derived key would let a later removal collide
 * with an earlier one and never reach the graph.
 */
export function syncedRowWriterWithRelationships<Table extends string, Tx>(
  writer: SyncedRowWriter<Table, Tx>,
  outbox: SyncedRowOutbox<Tx>,
  partitions: Pick<OwnerLock, "run">,
  relationshipsOf: ReadSyncedRowRelationships<Table, Tx>,
  mintCause: () => string = mintUuidV7,
): SyncedRowWriter<Table, Tx> {
  const moveKeyHoldersAside = writer.moveKeyHoldersAside?.bind(writer);

  const record = (tx: Tx, facts: readonly AccessChange[]) =>
    recordFacts(outbox, partitions, tx, facts);

  return {
    async upsert(tx, change) {
      const before = await read(relationshipsOf, tx, change.table, change.id);
      const written = await writer.upsert(tx, change);
      if (written !== true) return written;
      const after = await read(relationshipsOf, tx, change.table, change.id);
      await record(tx, changedFacts(before, after, mintCause()));
      return true;
    },

    async delete(tx, table, id) {
      const before = await read(relationshipsOf, tx, table, id);
      const deleted = await writer.delete(tx, table, id);
      if (deleted) await record(tx, factsFor("DELETE", before, mintCause()));
      return deleted;
    },

    ...(moveKeyHoldersAside === undefined ? {} : { moveKeyHoldersAside }),
  };
}

/**
 * States the relationships the given stored rows of a copy carry now, for
 * rows the copy held before it recorded relationships with each write (a
 * site upgraded past that build): each one is written, replacing any
 * waiting opposite fact for its tuple, as the wrapper's writes do. A row no
 * longer stored states nothing. Running it again writes the same tuples
 * again, which the graph keeps as they are. Answers how many facts it
 * recorded.
 */
export async function stateSyncedRowRelationships<Table extends string, Tx>(
  input: {
    readonly tx: Tx;
    readonly table: Table;
    readonly ids: readonly string[];
    readonly outbox: SyncedRowOutbox<Tx>;
    readonly partitions: Pick<OwnerLock, "run">;
    readonly relationshipsOf: ReadSyncedRowRelationships<Table, Tx>;
  },
  mintCause: () => string = mintUuidV7,
): Promise<number> {
  let recorded = 0;
  for (const id of input.ids) {
    const held = await read(input.relationshipsOf, input.tx, input.table, id);
    const facts = factsFor("WRITE", held, mintCause());
    await recordFacts(input.outbox, input.partitions, input.tx, facts);
    recorded += facts.length;
  }
  return recorded;
}

/** Records facts slice by slice, each replacing the waiting opposite fact under its slice's lock. */
async function recordFacts<Tx>(
  outbox: SyncedRowOutbox<Tx>,
  partitions: Pick<OwnerLock, "run">,
  tx: Tx,
  facts: readonly AccessChange[],
): Promise<void> {
  for (const [partition, group] of byPartition(facts)) {
    if (partition === null) await outbox.enqueue(group, tx);
    else
      await partitions.run(partition, (lease) =>
        outbox.enqueueReplacingOpposite(group, tx, lease),
      );
  }
}

/** One relationship and the authority slice it belongs to. */
type Placed = {
  readonly relationship: RelationshipWrite;
  readonly ownerPartitionId: string | null;
};

async function read<Table extends string, Tx>(
  relationshipsOf: ReadSyncedRowRelationships<Table, Tx>,
  tx: Tx,
  table: Table,
  id: string,
): Promise<Placed[]> {
  const answer = await relationshipsOf(tx, table, id);
  const groups = isGroupList(answer) ? answer : [answer];
  const placed = new Map<string, Placed>();
  for (const group of groups) {
    for (const relationship of group.relationships) {
      const entry = { relationship, ownerPartitionId: group.ownerPartitionId };
      placed.set(placedKey(entry), entry);
    }
  }
  return [...placed.values()];
}

function isGroupList(
  answer: SyncedRowRelationships | readonly SyncedRowRelationships[],
): answer is readonly SyncedRowRelationships[] {
  return Array.isArray(answer);
}

function changedFacts(
  before: readonly Placed[],
  after: readonly Placed[],
  cause: string,
): AccessChange[] {
  const kept = new Set(after.map(placedKey));
  const gone = before.filter((entry) => !kept.has(placedKey(entry)));
  return [
    ...factsFor("DELETE", gone, cause),
    ...factsFor("WRITE", after, cause),
  ];
}

function factsFor(
  operation: "WRITE" | "DELETE",
  entries: readonly Placed[],
  cause: string,
): AccessChange[] {
  return entries.map(({ relationship, ownerPartitionId }) => ({
    idempotencyKey: outboxKeyForRelationship(operation, relationship, cause),
    operation,
    relationship,
    ownerPartitionId,
  }));
}

/** Facts grouped by authority slice, in the order each slice first appears. */
function byPartition(
  facts: readonly AccessChange[],
): Map<string | null, AccessChange[]> {
  const groups = new Map<string | null, AccessChange[]>();
  for (const fact of facts) {
    const group = groups.get(fact.ownerPartitionId) ?? [];
    group.push(fact);
    groups.set(fact.ownerPartitionId, group);
  }
  return groups;
}

/** One tuple in one authority slice: the key of a write with no cause. */
function placedKey(entry: Placed): string {
  return `${entry.ownerPartitionId ?? ""}|${outboxKeyForRelationship("WRITE", entry.relationship, "")}`;
}
