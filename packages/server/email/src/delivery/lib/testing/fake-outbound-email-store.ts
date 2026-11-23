import type { OutboundEmailStore } from "../database/outbound-email-store.js";
import {
  type ClaimedOutboundEmail,
  type ImmediateOutboundEmail,
  type NewOutboundEmail,
  type OutboundEmailTx,
} from "../database/outbound-email-store.js";
import type { EmailEnvelope } from "../email-envelope.js";
import { type OutboundEmailId, type OutboundEmailStatus } from "../outbound-email-status.js";
import type { EmailFailurePolicy, QueuedEmailAttachment } from "../queued-email-attachment.js";
import { outboundEmailId } from "./outbound-email.factory.js";

/** One stored row, as the fake keeps it — the columns a unit test reads. */
export type FakeOutboundEmailRow = {
  attachments: readonly QueuedEmailAttachment[];
  failurePolicy: EmailFailurePolicy;
  id: OutboundEmailId;
  templateName: string;
  props: Record<string, unknown>;
  envelope: EmailEnvelope;
  sendAt: Date;
  status: OutboundEmailStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  claimedAt: Date | null;
  lastError: string | null;
  providerMessageId: string | null;
  dedupeKey: string | null;
  attachmentCount: number;
  sentAt: Date | null;
};

/**
 * An in-memory outbox with the same transitions as the Drizzle store, so a
 * unit test can watch a row move without a container. The claim is the same
 * conditional it is in SQL: due, queued, not already taken.
 *
 * `tx` is accepted and ignored — an in-memory store has nothing to join.
 */
export class FakeOutboundEmailStore implements OutboundEmailStore {
  readonly rows: FakeOutboundEmailRow[] = [];
  private sequence = 0;

  insert(record: NewOutboundEmail, tx?: OutboundEmailTx): Promise<{ id: OutboundEmailId; deduplicated: boolean }> {
    void tx;
    const dedupeKey = record.dedupeKey ?? null;
    const existing = dedupeKey === null ? undefined : this.rows.find((row) => row.dedupeKey === dedupeKey);
    if (existing) {
      return Promise.resolve({ id: existing.id, deduplicated: true });
    }
    const row = this.newRow({
      templateName: record.templateName,
      props: record.props,
      envelope: record.envelope,
      sendAt: record.sendAt,
      status: "queued",
      dedupeKey,
      attachments: structuredClone(record.attachments ?? []),
      failurePolicy: record.failurePolicy ?? "retry",
      attachmentCount: record.attachments?.length ?? 0,
    });
    return Promise.resolve({ id: row.id, deduplicated: false });
  }

  claimForSending(id: OutboundEmailId, now: Date): Promise<ClaimedOutboundEmail | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || !isDue(row, now)) return Promise.resolve(null);
    row.status = "sending";
    row.attempts += 1;
    row.claimedAt = now;
    return Promise.resolve({
      id: row.id,
      templateName: row.templateName,
      props: row.props,
      envelope: row.envelope,
      attempts: row.attempts,
      attachments: row.attachments,
      failurePolicy: row.failurePolicy,
    });
  }

  markSent(id: OutboundEmailId, result: { providerMessageId: string | null; sentAt: Date }): Promise<void> {
    this.settle(id, (row) => {
      row.status = "sent";
      row.providerMessageId = result.providerMessageId;
      row.sentAt = result.sentAt;
      row.claimedAt = null;
      row.lastError = null;
    });
    return Promise.resolve();
  }

  markRetryLater(id: OutboundEmailId, retry: { nextAttemptAt: Date; lastError: string }): Promise<void> {
    this.settle(id, (row) => {
      row.status = "queued";
      row.nextAttemptAt = retry.nextAttemptAt;
      row.lastError = retry.lastError;
      row.claimedAt = null;
    });
    return Promise.resolve();
  }

  markFailed(id: OutboundEmailId, failure: { lastError: string }): Promise<void> {
    this.settle(id, (row) => {
      row.status = "failed";
      row.lastError = failure.lastError;
      row.nextAttemptAt = null;
      row.claimedAt = null;
    });
    return Promise.resolve();
  }

  listDue(now: Date, limit: number): Promise<readonly OutboundEmailId[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => isDue(row, now))
        .sort((left, right) => left.sendAt.getTime() - right.sendAt.getTime())
        .slice(0, limit)
        .map((row) => row.id),
    );
  }

  failStaleClaims(olderThan: Date): Promise<readonly OutboundEmailId[]> {
    const stale = this.rows.filter(
      (row) => row.status === "sending" && row.claimedAt !== null && row.claimedAt.getTime() < olderThan.getTime(),
    );
    for (const row of stale) {
      row.status = "failed";
      row.lastError = "STALE_CLAIM";
      row.claimedAt = null;
    }
    return Promise.resolve(stale.map((row) => row.id));
  }

  requeueFailed(ids?: readonly OutboundEmailId[]): Promise<readonly OutboundEmailId[]> {
    const requeued = this.rows.filter((row) => row.status === "failed" && (ids === undefined || ids.includes(row.id)));
    for (const row of requeued) {
      row.status = "queued";
      row.attempts = 0;
      row.nextAttemptAt = null;
      row.claimedAt = null;
      row.lastError = null;
    }
    return Promise.resolve(requeued.map((row) => row.id));
  }

  recordImmediate(record: ImmediateOutboundEmail): Promise<{ id: OutboundEmailId }> {
    const row = this.newRow({
      templateName: record.templateName,
      props: record.props,
      envelope: record.envelope,
      sendAt: record.at,
      status: record.status,
      attempts: 1,
      providerMessageId: record.providerMessageId,
      lastError: record.lastError,
      attachmentCount: record.attachmentCount,
      sentAt: record.status === "sent" ? record.at : null,
    });
    return Promise.resolve({ id: row.id });
  }

  /** The row a test just wrote, by id. */
  find(id: OutboundEmailId): FakeOutboundEmailRow | undefined {
    return this.rows.find((row) => row.id === id);
  }

  private newRow(
    fields: Pick<FakeOutboundEmailRow, "templateName" | "props" | "envelope" | "sendAt" | "status"> &
      Partial<FakeOutboundEmailRow>,
  ): FakeOutboundEmailRow {
    this.sequence += 1;
    const row: FakeOutboundEmailRow = {
      id: outboundEmailId(this.sequence),
      attempts: 0,
      nextAttemptAt: null,
      claimedAt: null,
      lastError: null,
      providerMessageId: null,
      dedupeKey: null,
      attachmentCount: 0,
      sentAt: null,
      attachments: [],
      failurePolicy: "retry",
      ...fields,
    };
    this.rows.push(row);
    return row;
  }

  private settle(id: OutboundEmailId, change: (row: FakeOutboundEmailRow) => void): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) change(row);
  }
}

/** Queued, due, and not waiting on a scheduled retry — the claim's condition. */
function isDue(row: FakeOutboundEmailRow, now: Date): boolean {
  return (
    row.status === "queued" &&
    row.sendAt.getTime() <= now.getTime() &&
    (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now.getTime())
  );
}
