import type { DrizzleHandle } from "@dads-framework/postgres";
import type { EmailEnvelope } from "../email-envelope.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import type {
  EmailFailurePolicy,
  QueuedEmailAttachment,
} from "../queued-email-attachment.js";

/**
 * The slice of a Drizzle handle a caller may hand this store so an outbound
 * email is written in the same transaction as whatever asked for it. Insert
 * only, on purpose: a mutation never holds a handle it could update or query
 * the schema with, and dispatch happens after that transaction commits.
 */
export type OutboundEmailTx = Pick<DrizzleHandle, "insert">;

/** A send that has not happened yet. */
export type NewOutboundEmail = {
  readonly attachments?: readonly QueuedEmailAttachment[];
  readonly failurePolicy?: EmailFailurePolicy;
  readonly templateName: string;
  readonly props: Record<string, unknown>;
  readonly envelope: EmailEnvelope;
  /** When the row becomes due. `now` for immediate, later for a schedule. */
  readonly sendAt: Date;
  /**
   * Makes the enqueue idempotent: a second insert under the same key does
   * nothing and reports the first row's id. Derive it from the cause, not
   * from the message, so the key is spent exactly when the cause is.
   */
  readonly dedupeKey?: string | null;
};

/** One row, claimed by this attempt and nobody else. */
export type ClaimedOutboundEmail = {
  readonly attachments: readonly QueuedEmailAttachment[];
  readonly failurePolicy: EmailFailurePolicy;
  readonly id: OutboundEmailId;
  readonly templateName: string;
  readonly props: Record<string, unknown>;
  readonly envelope: EmailEnvelope;
  /** Including this one, so the backoff knows which attempt just ran. */
  readonly attempts: number;
};

/** A send that already happened, recorded by the immediate `sendNow` path. */
export type ImmediateOutboundEmail = {
  readonly templateName: string;
  readonly props: Record<string, unknown>;
  readonly envelope: EmailEnvelope;
  readonly status: "sent" | "failed";
  readonly providerMessageId: string | null;
  readonly lastError: string | null;
  /** How many files the message carried; never the bytes. */
  readonly attachmentCount: number;
  readonly at: Date;
};

/**
 * The outbound-email outbox as a port: the type the facade and the jobs hold,
 * and the injection token composition binds. `DrizzleOutboundEmailStore`
 * implements it against Postgres and `FakeOutboundEmailStore` stands in for
 * unit tests.
 *
 * There is deliberately no general `update` — every state change here is a
 * named transition, so "a `sending` row is never resent automatically"
 * (INV-EMAILDELIVERY-2) is a fact about the seam rather than a convention.
 */
export abstract class OutboundEmailStore {
  /**
   * Writes the row, optionally inside the caller's transaction. A conflict on
   * `dedupeKey` reports the existing row rather than raising, so a retried
   * transaction re-enqueuing the same email is a no-op.
   */
  abstract insert(
    record: NewOutboundEmail,
    tx?: OutboundEmailTx,
  ): Promise<{ id: OutboundEmailId; deduplicated: boolean }>;

  /**
   * Takes the row for one attempt: `queued` → `sending` with `attempts`
   * incremented, only when it is due. `null` means somebody else already has
   * it, it is not due yet, or it is no longer queued — all of which are
   * ordinary, none of which are errors (INV-EMAILDELIVERY-1).
   */
  abstract claimForSending(
    id: OutboundEmailId,
    now: Date,
  ): Promise<ClaimedOutboundEmail | null>;

  abstract markSent(
    id: OutboundEmailId,
    result: { providerMessageId: string | null; sentAt: Date },
  ): Promise<void>;

  /** Back to `queued`, due again at `nextAttemptAt`. */
  abstract markRetryLater(
    id: OutboundEmailId,
    retry: { nextAttemptAt: Date; lastError: string },
  ): Promise<void>;

  /** Terminal until an operator re-queues it; nothing retries a failed row. */
  abstract markFailed(
    id: OutboundEmailId,
    failure: { lastError: string },
  ): Promise<void>;

  /** Queued rows due at or before `now`, oldest first. */
  abstract listDue(
    now: Date,
    limit: number,
  ): Promise<readonly OutboundEmailId[]>;

  /**
   * Fails every row claimed before `olderThan` with `STALE_CLAIM`. A crash
   * mid-send leaves a row in `sending`, and the body may already have been
   * accepted by the vendor, so the sweep refuses rather than resending.
   */
  abstract failStaleClaims(
    olderThan: Date,
  ): Promise<readonly OutboundEmailId[]>;

  /** Returns failed rows to `queued` with a clean attempt count. */
  abstract requeueFailed(
    ids?: readonly OutboundEmailId[],
  ): Promise<readonly OutboundEmailId[]>;

  /** Records a send that already happened, settled, in one insert. */
  abstract recordImmediate(
    record: ImmediateOutboundEmail,
  ): Promise<{ id: OutboundEmailId }>;
}
