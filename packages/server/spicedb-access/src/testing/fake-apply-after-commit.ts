import { ApplyAccessChangesAfterCommit } from "../lib/access-changes/apply-after-commit.js";
import type { AccessChange } from "../lib/access-changes/enqueue.js";
import type { Authorization } from "@dads-framework/access/runtime";

/**
 * Projects enqueued facts straight into a `FakeAuthorization`, so a mutation
 * unit test sees what the product sees: create, and the tuple is there.
 *
 * `paused` is the interesting setting. It reproduces a dispatch that never
 * ran — the crash the outbox exists for — so a test can assert the row was
 * still enqueued, then run a real projector and watch the tuple appear. That
 * is the wave's demo milestone in unit form.
 *
 * **Do not copy this shape into production.** It reaches the graph directly,
 * which `createApplyAccessChangesAfterCommit` deliberately does not: the real
 * one delegates to the projector so that claim and settle stay projector-only
 * (INV-AUTHORIZATION-4). Here there is no store to claim from, and a fake that
 * pretended otherwise would be testing the fake.
 */
export class FakeApplyAccessChangesAfterCommit extends ApplyAccessChangesAfterCommit {
  /** When true, dispatch records the call and projects nothing. */
  paused = false;

  private readonly seen: AccessChange[] = [];

  constructor(private readonly authorization: Authorization) {
    super();
  }

  async dispatch(entries: readonly AccessChange[]): Promise<void> {
    this.seen.push(...entries);
    if (this.paused) return;
    for (const entry of entries) {
      if (entry.operation === "WRITE") {
        await this.authorization.writeRelationships([entry.relationship]);
      } else {
        const { resource, relation, subject } = entry.relationship;
        await this.authorization.deleteRelationships({
          resourceType: resource.type,
          resourceId: resource.id,
          relation,
          subject,
        });
      }
    }
  }

  /** Everything handed to dispatch so far, in order. */
  get dispatched(): readonly AccessChange[] {
    return [...this.seen];
  }
}
