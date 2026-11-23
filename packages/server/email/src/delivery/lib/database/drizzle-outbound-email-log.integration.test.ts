import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
  truncateTables,
} from "@dads-framework/postgres/testing";
import { mintUuidV7 } from "@dads-framework/core/contract";

import type { EmailEnvelope } from "../email-envelope.js";
import {
  type OutboundEmailId,
  outboundEmailIdSchema,
} from "../outbound-email-status.js";
import { DrizzleOutboundEmailLog } from "./drizzle-outbound-email-log.js";
import { outboundEmail } from "./generated-tables/outbound-emails.tables.js";

const EARLIER = new Date("2026-10-01T09:00:00.000Z");
const LATER = new Date("2026-10-01T10:00:00.000Z");

describe("DrizzleOutboundEmailLog (integration)", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let log: DrizzleOutboundEmailLog;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    log = new DrizzleOutboundEmailLog(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  beforeEach(async () => {
    await truncateTables(postgres.pool, ["outbound_emails"]);
  });

  async function seed(input: {
    readonly envelope: EmailEnvelope;
    readonly createdAt: Date;
  }): Promise<OutboundEmailId> {
    const id = outboundEmailIdSchema.parse(mintUuidV7());
    await db.insert(outboundEmail).values({
      id,
      templateName: "identity.sign-in-link",
      props: { url: "https://app.example.test/sign-in?token=abc" },
      envelope: input.envelope,
      sendAt: input.createdAt,
      status: "sent",
      createdAt: input.createdAt,
      sentAt: input.createdAt,
    });
    return id;
  }

  it("lists newest first, pages by offset and counts every row", async () => {
    const older = await seed({
      envelope: { to: [{ address: "dana@example.test" }] },
      createdAt: EARLIER,
    });
    const newer = await seed({
      envelope: { to: [{ address: "lee@example.test" }] },
      createdAt: LATER,
    });

    const first = await log.list({ offset: 0, limit: 1 });
    const second = await log.list({ offset: 1, limit: 1 });

    expect(first.total).toBe(2);
    expect(first.rows.map((row) => row.id)).toEqual([newer]);
    expect(second.rows.map((row) => row.id)).toEqual([older]);
    expect(first.rows[0]).toMatchObject({
      templateName: "identity.sign-in-link",
      props: { url: "https://app.example.test/sign-in?token=abc" },
      envelope: { to: [{ address: "lee@example.test" }] },
      status: "sent",
      sentAt: LATER,
    });
  });

  it("finds a recipient in To, Cc or Bcc, ignoring case, and counts only matches", async () => {
    const inTo = await seed({
      envelope: { to: [{ address: "Dana@Example.test" }] },
      createdAt: EARLIER,
    });
    const inCc = await seed({
      envelope: {
        to: [{ address: "lee@example.test" }],
        cc: [{ address: "dana@example.test" }],
      },
      createdAt: LATER,
    });
    await seed({
      envelope: { to: [{ address: "lee@example.test" }] },
      createdAt: LATER,
    });

    const page = await log.list({
      recipient: "dana@",
      offset: 0,
      limit: 25,
    });

    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.id)).toEqual([inCc, inTo]);
  });

  it("takes LIKE wildcards in the search literally", async () => {
    await seed({
      envelope: { to: [{ address: "dana@example.test" }] },
      createdAt: EARLIER,
    });

    const page = await log.list({ recipient: "%", offset: 0, limit: 25 });

    expect(page.total).toBe(0);
  });

  it("reads a stored envelope it can no longer parse as null rather than failing", async () => {
    const id = await seed({ envelope: { to: [] }, createdAt: EARLIER });

    expect(await log.find(id)).toMatchObject({ id, envelope: null });
  });

  it("finds nothing for an id with no row", async () => {
    expect(
      await log.find(outboundEmailIdSchema.parse(mintUuidV7())),
    ).toBeNull();
  });
});
