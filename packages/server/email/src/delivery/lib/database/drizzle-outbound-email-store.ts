import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";
import { mintUuidV7 } from "@dads-framework/core/contract";

import { type EmailEnvelope, emailEnvelopeSchema } from "../email-envelope.js";
import {
  type OutboundEmailId,
  outboundEmailIdSchema,
} from "../outbound-email-status.js";
import { queuedEmailAttachmentsSchema } from "../queued-email-attachment.js";
import { outboundEmailDocument } from "./generated-tables/outbound-email-documents.tables.js";
import { outboundEmail } from "./generated-tables/outbound-emails.tables.js";
import { outboundEmailPropsSchema } from "./outbound-email-props.js";
import type { OutboundEmailStore } from "./outbound-email-store.js";
import {
  type ClaimedOutboundEmail,
  type ImmediateOutboundEmail,
  type NewOutboundEmail,
  type OutboundEmailTx,
} from "./outbound-email-store.js";

/** What a stale claim records, so the reason is greppable rather than prose. */
export const STALE_CLAIM_ERROR = "STALE_CLAIM";

/**
 * Postgres adapter for the outbox. Every state change is one conditional
 * statement, which is what makes the claim a wall rather than a convention:
 * two workers racing the same row both run the same conditional update from
 * `queued` to `sending`, and PostgreSQL lets exactly one of them match.
 */
export class DrizzleOutboundEmailStore implements OutboundEmailStore {
  constructor(private readonly db: DrizzleHandle) {}

  async insert(
    record: NewOutboundEmail,
    tx?: OutboundEmailTx,
  ): Promise<{ id: OutboundEmailId; deduplicated: boolean }> {
    if (tx === undefined && hasQueuedDocuments(record)) {
      return this.db.transaction((transaction) =>
        this.insert(record, transaction),
      );
    }
    const writer = tx ?? this.db;
    const attachments = queuedEmailAttachmentsSchema.parse(
      record.attachments ?? [],
    );
    const inserted = await writer
      .insert(outboundEmail)
      .values({
        id: outboundEmailIdSchema.parse(mintUuidV7()),
        templateName: record.templateName,
        props: record.props,
        envelope: record.envelope,
        sendAt: record.sendAt,
        status: "queued",
        dedupeKey: record.dedupeKey ?? null,
        attachmentCount: attachments.length,
      })
      // Bare, not targeted: the only unique index that can conflict is the
      // partial one on `dedupe_key`, and a partial index needs its predicate
      // repeated to be named as an arbiter. Nothing is gained by spelling it.
      .onConflictDoNothing()
      .returning({ id: outboundEmail.id });

    const row = inserted[0];
    if (row) {
      await this.insertDocuments(writer, row.id, record);
      return { id: row.id, deduplicated: false };
    }
    return {
      id: await this.findByDedupeKey(record.dedupeKey),
      deduplicated: true,
    };
  }

  private async insertDocuments(
    writer: OutboundEmailTx,
    id: OutboundEmailId,
    record: NewOutboundEmail,
  ): Promise<void> {
    if (!hasQueuedDocuments(record)) return;
    await writer.insert(outboundEmailDocument).values({
      outboundEmailId: id,
      attachments: queuedEmailAttachmentsSchema.parse(record.attachments ?? []),
      failurePolicy: record.failurePolicy ?? "retry",
    });
  }

  async claimForSending(
    id: OutboundEmailId,
    now: Date,
  ): Promise<ClaimedOutboundEmail | null> {
    const claimed = await this.db
      .update(outboundEmail)
      .set({
        status: "sending",
        attempts: sql`${outboundEmail.attempts} + 1`,
        claimedAt: now,
      })
      .where(
        and(
          eq(outboundEmail.id, id),
          eq(outboundEmail.status, "queued"),
          lte(outboundEmail.sendAt, now),
          this.dueForRetry(now),
        ),
      )
      .returning({
        id: outboundEmail.id,
        templateName: outboundEmail.templateName,
        props: outboundEmail.props,
        envelope: outboundEmail.envelope,
        attempts: outboundEmail.attempts,
      });

    const row = claimed[0];
    if (!row) return null;
    const documents = await this.db
      .select()
      .from(outboundEmailDocument)
      .where(eq(outboundEmailDocument.outboundEmailId, row.id))
      .limit(1);
    const document = documents[0];
    return {
      id: row.id,
      templateName: row.templateName,
      props: outboundEmailPropsSchema.parse(row.props),
      envelope: parseEnvelope(row.id, row.envelope),
      attempts: row.attempts,
      attachments: queuedEmailAttachmentsSchema.parse(
        document?.attachments ?? [],
      ),
      failurePolicy: document?.failurePolicy ?? "retry",
    };
  }

  async markSent(
    id: OutboundEmailId,
    result: { providerMessageId: string | null; sentAt: Date },
  ): Promise<void> {
    await this.db
      .update(outboundEmail)
      .set({
        status: "sent",
        providerMessageId: result.providerMessageId,
        sentAt: result.sentAt,
        claimedAt: null,
        lastError: null,
      })
      .where(eq(outboundEmail.id, id));
  }

  async markRetryLater(
    id: OutboundEmailId,
    retry: { nextAttemptAt: Date; lastError: string },
  ): Promise<void> {
    await this.db
      .update(outboundEmail)
      .set({
        status: "queued",
        nextAttemptAt: retry.nextAttemptAt,
        lastError: retry.lastError,
        claimedAt: null,
      })
      .where(eq(outboundEmail.id, id));
  }

  async markFailed(
    id: OutboundEmailId,
    failure: { lastError: string },
  ): Promise<void> {
    await this.db
      .update(outboundEmail)
      .set({
        status: "failed",
        lastError: failure.lastError,
        nextAttemptAt: null,
        claimedAt: null,
      })
      .where(eq(outboundEmail.id, id));
  }

  async listDue(now: Date, limit: number): Promise<readonly OutboundEmailId[]> {
    const due = await this.db
      .select({ id: outboundEmail.id })
      .from(outboundEmail)
      .where(
        and(
          eq(outboundEmail.status, "queued"),
          lte(outboundEmail.sendAt, now),
          this.dueForRetry(now),
        ),
      )
      .orderBy(asc(outboundEmail.sendAt))
      .limit(limit);
    return due.map((row) => row.id);
  }

  async failStaleClaims(olderThan: Date): Promise<readonly OutboundEmailId[]> {
    const failed = await this.db
      .update(outboundEmail)
      .set({
        status: "failed",
        lastError: STALE_CLAIM_ERROR,
        claimedAt: null,
      })
      .where(
        and(
          eq(outboundEmail.status, "sending"),
          lt(outboundEmail.claimedAt, olderThan),
        ),
      )
      .returning({ id: outboundEmail.id });
    return failed.map((row) => row.id);
  }

  async requeueFailed(
    ids?: readonly OutboundEmailId[],
  ): Promise<readonly OutboundEmailId[]> {
    // An explicit empty selection re-queues nothing; omitting `ids` entirely
    // is what means "every failed row".
    if (ids?.length === 0) return [];
    const requeued = await this.db
      .update(outboundEmail)
      .set({
        status: "queued",
        attempts: 0,
        nextAttemptAt: null,
        claimedAt: null,
        lastError: null,
      })
      .where(
        ids === undefined
          ? eq(outboundEmail.status, "failed")
          : and(
              eq(outboundEmail.status, "failed"),
              inArray(outboundEmail.id, [...ids]),
            ),
      )
      .returning({ id: outboundEmail.id });
    return requeued.map((row) => row.id);
  }

  async recordImmediate(
    record: ImmediateOutboundEmail,
  ): Promise<{ id: OutboundEmailId }> {
    const inserted = await this.db
      .insert(outboundEmail)
      .values({
        id: outboundEmailIdSchema.parse(mintUuidV7()),
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
      })
      .returning({ id: outboundEmail.id });

    const row = inserted[0];
    if (!row) throw new Error("Insert returned no row");
    return { id: row.id };
  }

  /** A row with no scheduled retry is due; one with a retry waits for it. */
  private dueForRetry(now: Date) {
    return or(
      isNull(outboundEmail.nextAttemptAt),
      lte(outboundEmail.nextAttemptAt, now),
    );
  }

  /**
   * The id of the row that won the dedupe race. Read through the store's own
   * handle rather than the caller's insert-only transaction, which is correct
   * because a conflict is with a COMMITTED row — an uncommitted one would
   * have blocked the insert instead.
   */
  private async findByDedupeKey(
    dedupeKey: string | null | undefined,
  ): Promise<OutboundEmailId> {
    if (dedupeKey === null || dedupeKey === undefined) {
      throw new Error(
        "An outbound email with no dedupe key cannot conflict; the insert was refused for another reason",
      );
    }
    const existing = await this.db
      .select({ id: outboundEmail.id })
      .from(outboundEmail)
      .where(eq(outboundEmail.dedupeKey, dedupeKey))
      .limit(1);
    const row = existing[0];
    if (!row) {
      throw new Error(
        "An outbound email was deduplicated against a row this connection cannot see — enqueue the same dedupe key once per transaction",
      );
    }
    return row.id;
  }
}

function hasQueuedDocuments(record: NewOutboundEmail): boolean {
  return (
    (record.attachments?.length ?? 0) > 0 ||
    record.failurePolicy === "manual-review"
  );
}

/**
 * A row written by an older build must fail here, loudly, rather than reach a
 * vendor half-formed — which is why the column is parsed and never cast.
 */
function parseEnvelope(id: OutboundEmailId, stored: unknown): EmailEnvelope {
  const parsed = emailEnvelopeSchema.safeParse(stored);
  if (!parsed.success) {
    throw new Error(
      `Outbound email ${id} carries an envelope this build cannot read`,
    );
  }
  return parsed.data;
}
