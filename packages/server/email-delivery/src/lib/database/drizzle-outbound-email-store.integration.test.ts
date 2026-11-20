/**
 * WHAT: the outbox's transitions against a real PostgreSQL — the claim, the
 * dedupe, the due window, stale claims and the operator re-queue.
 *
 * WHY against a real database: every one of these is a conditional statement
 * whose correctness belongs to PostgreSQL, not to TypeScript. "Claimed
 * exactly once" (INV-EMAILDELIVERY-1) is the `WHERE status='queued'` of an
 * UPDATE racing itself; a partial unique index is what makes a dedupe key
 * idempotent. A fake can only restate the intention, so the intention is
 * checked here and the fake is checked against this shape.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
  truncateTables,
} from "@dads-framework/postgres/testing";

import type { EmailEnvelope } from "../email-envelope.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import { seedQueuedEmailWithDocuments } from "../testing/queued-email.seeder.js";
import {
  DrizzleOutboundEmailStore,
  STALE_CLAIM_ERROR,
} from "./drizzle-outbound-email-store.js";
import { outboundEmailDocument } from "./generated-tables/outbound-email-documents.tables.js";
import { outboundEmail } from "./generated-tables/outbound-emails.tables.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const LATER = new Date("2026-09-11T12:30:00.000Z");
const ENVELOPE: EmailEnvelope = {
  to: [{ address: "dana@example.test", name: "Dana Reyes" }],
  tags: ["invitation"],
};

describe("DrizzleOutboundEmailStore (integration)", () => {
  let postgres: TestPostgres;
  let store: DrizzleOutboundEmailStore;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    store = new DrizzleOutboundEmailStore(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  beforeEach(async () => {
    await truncateTables(postgres.pool, ["outbound_emails"]);
  });

  async function enqueueDue(
    overrides: { sendAt?: Date; dedupeKey?: string } = {},
  ): Promise<OutboundEmailId> {
    const { id } = await store.insert({
      templateName: "email-templates.component-showcase",
      props: { recipientName: "Dana Reyes" },
      envelope: ENVELOPE,
      sendAt: overrides.sendAt ?? NOW,
      dedupeKey: overrides.dedupeKey ?? null,
    });
    return id;
  }

  async function readRow(id: OutboundEmailId) {
    const rows = await db
      .select()
      .from(outboundEmail)
      .where(eq(outboundEmail.id, id));
    return rows[0];
  }

  it("writes a queued row and round-trips the jsonb envelope", async () => {
    const id = await enqueueDue();

    expect(await readRow(id)).toMatchObject({
      templateName: "email-templates.component-showcase",
      status: "queued",
      attempts: 0,
      envelope: ENVELOPE,
      providerMessageId: null,
      attachmentCount: 0,
    });
  });

  it("round-trips immutable attachment references and the transport failure policy", async () => {
    const attachment = {
      objectKey: "vector/approved/po-1.pdf",
      filename: "PO-1.pdf",
      contentType: "application/pdf",
      byteSize: 3,
      sha256: "a".repeat(64),
    };
    const queued = await store.insert({
      templateName: "vector.purchase-order",
      props: {},
      envelope: ENVELOPE,
      sendAt: NOW,
      attachments: [attachment],
      failurePolicy: "manual-review",
    });

    expect(await store.claimForSending(queued.id, NOW)).toMatchObject({
      attachments: [attachment],
      failurePolicy: "manual-review",
    });
    expect(await readRow(queued.id)).toMatchObject({ attachmentCount: 1 });
    await expect(
      postgres.pool.query(
        "UPDATE outbound_email_documents SET attachments = '[]' WHERE outbound_email_id = $1",
        [queued.id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("seeds a queued parent email with matching document references", async () => {
    const attachment = {
      objectKey: "vector/approved/po-seeded.pdf",
      filename: "PO-seeded.pdf",
      contentType: "application/pdf",
      byteSize: 3,
      sha256: "b".repeat(64),
    };
    const seeded = await seedQueuedEmailWithDocuments(db, {
      email: { sendAt: NOW, envelope: ENVELOPE },
      document: { attachments: [attachment] },
    });

    expect(
      await store.claimForSending(seeded.document.outboundEmailId, NOW),
    ).toMatchObject({
      attachments: [attachment],
      failurePolicy: "manual-review",
    });
    expect(await readRow(seeded.document.outboundEmailId)).toMatchObject({
      id: seeded.email.id,
      attachmentCount: 1,
    });
  });

  it("rolls back attachment references with the caller's transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await store.insert(
          {
            templateName: "vector.purchase-order",
            props: {},
            envelope: ENVELOPE,
            sendAt: NOW,
            failurePolicy: "manual-review",
          },
          tx,
        );
        throw new Error("cancel transaction");
      }),
    ).rejects.toThrow();

    expect(await db.select().from(outboundEmailDocument)).toEqual([]);
    expect(await db.select().from(outboundEmail)).toEqual([]);
  });

  it("rolls back with the caller's transaction, leaving no row behind", async () => {
    await expect(
      db.transaction(async (tx) => {
        await store.insert(
          {
            templateName: "email-templates.component-showcase",
            props: {},
            envelope: ENVELOPE,
            sendAt: NOW,
          },
          tx,
        );
        throw new Error("the caller's own work failed");
      }),
    ).rejects.toThrow("the caller's own work failed");

    expect(await db.select().from(outboundEmail)).toHaveLength(0);
  });

  it("claims a due row once and refuses the second claimant", async () => {
    const id = await enqueueDue();

    const first = await store.claimForSending(id, NOW);
    const second = await store.claimForSending(id, NOW);

    expect(first).toMatchObject({ id, attempts: 1, envelope: ENVELOPE });
    expect(second).toBeNull();
    expect(await readRow(id)).toMatchObject({
      status: "sending",
      attempts: 1,
      claimedAt: NOW,
    });
  });

  it("will not claim a row whose send time has not arrived", async () => {
    const id = await enqueueDue({ sendAt: LATER });

    expect(await store.claimForSending(id, NOW)).toBeNull();
    expect(await store.claimForSending(id, LATER)).toMatchObject({ id });
  });

  it("reports the first row's id when a dedupe key is reused", async () => {
    const first = await enqueueDue({ dedupeKey: "invitation:42" });

    const second = await store.insert({
      templateName: "email-templates.component-showcase",
      props: { recipientName: "Somebody else" },
      envelope: ENVELOPE,
      sendAt: NOW,
      dedupeKey: "invitation:42",
    });

    expect(second).toEqual({ id: first, deduplicated: true });
    expect(await db.select().from(outboundEmail)).toHaveLength(1);
  });

  it("lets rows with no dedupe key coexist", async () => {
    await enqueueDue();
    await enqueueDue();

    expect(await db.select().from(outboundEmail)).toHaveLength(2);
  });

  it("holds a row back until its scheduled retry, then lists it as due", async () => {
    const id = await enqueueDue();
    await store.claimForSending(id, NOW);
    await store.markRetryLater(id, {
      nextAttemptAt: LATER,
      lastError: "Error: vendor timeout",
    });

    expect(await store.listDue(NOW, 10)).toEqual([]);
    expect(await store.listDue(LATER, 10)).toEqual([id]);
    expect(await store.claimForSending(id, NOW)).toBeNull();
  });

  it("fails only claims older than the stale window", async () => {
    const stale = await enqueueDue();
    const fresh = await enqueueDue();
    await store.claimForSending(stale, NOW);
    await store.claimForSending(fresh, LATER);

    const failed = await store.failStaleClaims(
      new Date("2026-09-11T12:15:00.000Z"),
    );

    expect(failed).toEqual([stale]);
    expect(await readRow(stale)).toMatchObject({
      status: "failed",
      lastError: STALE_CLAIM_ERROR,
      claimedAt: null,
    });
    expect(await readRow(fresh)).toMatchObject({ status: "sending" });
  });

  it("re-queues failed rows with a clean attempt count", async () => {
    const id = await enqueueDue();
    await store.claimForSending(id, NOW);
    await store.markFailed(id, { lastError: "Error: vendor rejected" });

    expect(await store.requeueFailed([id])).toEqual([id]);
    expect(await readRow(id)).toMatchObject({
      status: "queued",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("re-queues nothing that did not fail", async () => {
    const sent = await enqueueDue();
    await store.claimForSending(sent, NOW);
    await store.markSent(sent, { providerMessageId: "mg-1", sentAt: NOW });

    expect(await store.requeueFailed()).toEqual([]);
    expect(await readRow(sent)).toMatchObject({
      status: "sent",
      providerMessageId: "mg-1",
      sentAt: NOW,
    });
  });

  it("records an immediate send as one settled row", async () => {
    const { id } = await store.recordImmediate({
      templateName: "identity.account-invitation",
      props: { invitedName: "Dana Reyes" },
      envelope: ENVELOPE,
      status: "sent",
      providerMessageId: "mg-immediate",
      lastError: null,
      attachmentCount: 2,
      at: NOW,
    });

    expect(await readRow(id)).toMatchObject({
      status: "sent",
      attempts: 1,
      providerMessageId: "mg-immediate",
      attachmentCount: 2,
      sentAt: NOW,
    });
  });

  it("refuses an envelope this build cannot read rather than sending it", async () => {
    const id = await enqueueDue();
    await db
      .update(outboundEmail)
      .set({ envelope: { to: [{ address: "not-an-address" }] } })
      .where(eq(outboundEmail.id, id));

    await expect(store.claimForSending(id, NOW)).rejects.toThrow(/envelope/);
  });
});
