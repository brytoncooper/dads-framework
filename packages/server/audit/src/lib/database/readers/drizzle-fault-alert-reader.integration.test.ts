/**
 * WHAT: the two halves of "new" hold against real SQL — a fault is reported
 * when it is happening inside the window AND `known_fault_fingerprints` has
 * never heard of it, and not otherwise.
 *
 * WHY against a real database: the rule is a `NOT EXISTS` correlated against a
 * composite primary key, and the seed is one `INSERT ... SELECT ... UNION ...
 * ON CONFLICT DO NOTHING`. Neither has behavior a fake could disagree with —
 * a wrong correlation still returns rows, an origin dropped from the key still
 * returns rows, and both are silently wrong in production. Only Postgres can
 * say whether they group and filter the way the alert claims.
 *
 * `request_log` carries no trigger and nothing references it, so each test
 * truncates its own tables rather than building a graph.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
  truncateRequestLog,
  truncateTables,
} from "@dads-framework/postgres/testing";
import { mintEntityId } from "@dads-framework/core/contract";

import { makeRequestLog } from "../../../testing/request-log.factory.js";
import { clientDiagnosticEventIdSchema } from "../../client-diagnostics/client-diagnostic-event.ids.js";
import { clientDiagnosticEvents } from "../generated-tables/client-diagnostic-events.tables.js";
import { knownFaultFingerprints } from "../generated-tables/known-fault-fingerprints.tables.js";
import { requestLog } from "../generated-tables/request-log.tables.js";
import { DrizzleFaultAlertReader } from "./drizzle-fault-alert-reader.js";

const INSIDE_WINDOW = new Date("2026-09-14T11:30:00.000Z");
const BEFORE_WINDOW = new Date("2026-09-01T08:00:00.000Z");
const WINDOW_START = new Date("2026-09-14T11:00:00.000Z");

describe("DrizzleFaultAlertReader", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let reader: DrizzleFaultAlertReader;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    reader = new DrizzleFaultAlertReader(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateRequestLog(postgres.pool);
    await truncateTables(postgres.pool, [
      "client_diagnostic_events",
      "known_fault_fingerprints",
    ]);
  });

  it("groups a fault inside the window and counts only its own occurrences", async () => {
    await recordServerFault("boom0001", INSIDE_WINDOW, 3);
    await recordServerFault("boom0002", INSIDE_WINDOW, 1);
    await recordServerFault("boom0001", BEFORE_WINDOW, 9);

    const faults = await reader.unalertedServerFaultsSince(WINDOW_START);

    expect(faults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: "boom0001",
          type: "TypeError",
          occurrences: 3,
          where: "/organizations/:organizationId/orders",
        }),
        expect.objectContaining({ fingerprint: "boom0002", occurrences: 1 }),
      ]),
    );
    expect(faults).toHaveLength(2);
  });

  it("ignores a request that carries no fault at all", async () => {
    await db.insert(requestLog).values(
      makeRequestLog({
        recordedAt: INSIDE_WINDOW,
        exceptionType: null,
        exceptionFingerprint: null,
      }),
    );

    expect(await reader.unalertedServerFaultsSince(WINDOW_START)).toEqual([]);
  });

  it("drops a fault the memory already holds, and keeps one it does not", async () => {
    await recordServerFault("remembered", INSIDE_WINDOW, 4);
    await recordServerFault("stranger01", INSIDE_WINDOW, 4);
    await reader.rememberAlertedFaults([
      { origin: "server", fingerprint: "remembered" },
    ]);

    const faults = await reader.unalertedServerFaultsSince(WINDOW_START);

    expect(faults.map((fault) => fault.fingerprint)).toEqual(["stranger01"]);
  });

  it("keeps a server fingerprint and an identical client one apart", async () => {
    // Different code computes the two over different inputs, so the same eight
    // characters can be two unrelated faults. Remembering one must not silence
    // the other.
    await recordServerFault("collision", INSIDE_WINDOW, 1);
    await recordClientFault("collision", INSIDE_WINDOW);
    await reader.rememberAlertedFaults([
      { origin: "server", fingerprint: "collision" },
    ]);

    expect(await reader.unalertedServerFaultsSince(WINDOW_START)).toEqual([]);
    expect(
      (await reader.unalertedClientFaultsSince(WINDOW_START)).map(
        (fault) => fault.fingerprint,
      ),
    ).toEqual(["collision"]);
  });

  it("never alerts on an info row, which is a measurement and not a fault", async () => {
    await recordClientFault("timing01", INSIDE_WINDOW, "info");
    await recordClientFault("broken01", INSIDE_WINDOW);

    const faults = await reader.unalertedClientFaultsSince(WINDOW_START);

    expect(faults.map((fault) => fault.fingerprint)).toEqual(["broken01"]);
  });

  it("remembers a fault once, however often it is alerted", async () => {
    await reader.rememberAlertedFaults([
      { origin: "server", fingerprint: "twice0001" },
    ]);
    await reader.rememberAlertedFaults([
      { origin: "server", fingerprint: "twice0001" },
    ]);

    expect(await db.select().from(knownFaultFingerprints)).toHaveLength(1);
  });

  it("reports nothing to remember before anything has been", async () => {
    expect(await reader.hasRememberedAnyFault()).toBe(false);

    await reader.rememberAlertedFaults([
      { origin: "client", fingerprint: "anything" },
    ]);

    expect(await reader.hasRememberedAnyFault()).toBe(true);
  });

  it("seeds both origins from what predates the window, and nothing newer", async () => {
    await recordServerFault("oldserver1", BEFORE_WINDOW, 2);
    await recordClientFault("oldclient1", BEFORE_WINDOW);
    await recordServerFault("newserver1", INSIDE_WINDOW, 2);

    expect(await reader.rememberFaultsSeenBefore(WINDOW_START)).toBe(2);

    const remembered = await db.select().from(knownFaultFingerprints);
    expect(
      remembered.map((row) => `${row.origin}:${row.fingerprint}`).toSorted(),
    ).toEqual(["client:oldclient1", "server:oldserver1"]);
    // The one that only started inside the window is still news.
    expect(
      (await reader.unalertedServerFaultsSince(WINDOW_START)).map(
        (fault) => fault.fingerprint,
      ),
    ).toEqual(["newserver1"]);
  });

  it("seeds nothing twice when it runs against a memory that already holds one", async () => {
    await recordServerFault("oldserver1", BEFORE_WINDOW, 1);
    await reader.rememberAlertedFaults([
      { origin: "server", fingerprint: "oldserver1" },
    ]);

    expect(await reader.rememberFaultsSeenBefore(WINDOW_START)).toBe(0);
    expect(await db.select().from(knownFaultFingerprints)).toHaveLength(1);
  });

  async function recordServerFault(
    fingerprint: string,
    recordedAt: Date,
    occurrences: number,
  ): Promise<void> {
    await db.insert(requestLog).values(
      Array.from({ length: occurrences }, () =>
        makeRequestLog({
          recordedAt,
          status: 500,
          exceptionType: "TypeError",
          exceptionFingerprint: fingerprint,
        }),
      ),
    );
  }

  async function recordClientFault(
    fingerprint: string,
    recordedAt: Date,
    severity: "error" | "info" = "error",
  ): Promise<void> {
    await db.insert(clientDiagnosticEvents).values({
      id: mintEntityId(clientDiagnosticEventIdSchema),
      recordedAt,
      occurredAt: recordedAt,
      fingerprint,
      kind: "render",
      severity,
      name: "TypeError",
      message: "cannot read properties of undefined",
      frames: [],
      breadcrumbs: [],
      release: "2026.09.14-1",
      client: "web",
      requestId: null,
      actorKind: "user",
      actorId: "test",
      context: null,
    });
  }
});
