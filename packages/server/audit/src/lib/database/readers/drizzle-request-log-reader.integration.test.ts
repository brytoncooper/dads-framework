import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ClientContext } from "@dads-framework/core/contract";
import { requestIdSchema } from "@dads-framework/http";
import { startTestPostgres, truncateRequestLog, type TestPostgres } from "@dads-framework/postgres/testing";

import { makeRequestLog } from "../../../testing/request-log.factory.js";
import { requestLog } from "../generated-tables/request-log.tables.js";
import { DrizzleRequestLogReader } from "./drizzle-request-log-reader.js";

const SINCE = new Date("2026-10-01T00:00:00Z");

describe("DrizzleRequestLogReader", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let reader: DrizzleRequestLogReader;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    reader = new DrizzleRequestLogReader(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateRequestLog(postgres.pool);
  });

  const id = (value: string) => requestIdSchema.parse(value);

  it("finds one request's environment by its id", async () => {
    const context: ClientContext = {
      version: 1,
      client: "web",
      build: "test-build",
      timeZone: "America/Boise",
      locale: "en-US",
    };
    await db.insert(requestLog).values(
      makeRequestLog({
        requestId: id("req-env"),
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0",
        clientContext: context,
      }),
    );

    const found = await reader.findRequest("req-env");

    expect(found?.ip).toBe("203.0.113.7");
    expect(found?.userAgent).toBe("Mozilla/5.0");
    expect(found?.clientContext).toEqual(context);
    expect(await reader.findRequest("req-missing")).toBeNull();
  });

  it("lists only refused requests inside the window, newest first", async () => {
    await db.insert(requestLog).values([
      makeRequestLog({
        requestId: id("allowed"),
        decision: "allow",
        recordedAt: new Date("2026-10-20T10:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("denied"),
        decision: "denied",
        recordedAt: new Date("2026-10-20T11:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("hidden"),
        decision: "not-found",
        recordedAt: new Date("2026-10-21T11:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("too-old"),
        decision: "denied",
        recordedAt: new Date("2026-09-01T11:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("broken"),
        decision: "error",
        recordedAt: new Date("2026-10-21T12:00:00Z"),
      }),
    ]);

    const refusals = await reader.listRefusals({ since: SINCE }, null, 10);

    expect(refusals.map((row) => row.requestId)).toEqual(["hidden", "denied"]);
  });

  it("lists only refusals of a signed-in actor, never one made before sign-in", async () => {
    await db.insert(requestLog).values([
      makeRequestLog({
        requestId: id("signed-in"),
        decision: "denied",
        actorKind: "user",
        actorId: "alice",
        recordedAt: new Date("2026-10-20T10:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("device"),
        decision: "denied",
        actorKind: "device",
        actorId: "kiosk-1",
        recordedAt: new Date("2026-10-20T11:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("before-sign-in"),
        decision: "not-found",
        actorKind: "anonymous",
        actorId: "",
        recordedAt: new Date("2026-10-20T12:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("no-actor-id"),
        decision: "unauthenticated",
        actorKind: "user",
        actorId: "",
        recordedAt: new Date("2026-10-20T13:00:00Z"),
      }),
    ]);

    const refusals = await reader.listRefusals({ since: SINCE }, null, 10);

    expect(refusals.map((row) => row.requestId)).toEqual(["device", "signed-in"]);
  });

  it("never lists a refusal row a remote instance uploaded, only this API's own and rows with no instance", async () => {
    await db.insert(requestLog).values([
      makeRequestLog({
        requestId: id("api-instance"),
        decision: "denied",
        instanceId: "api-1",
        recordedAt: new Date("2026-10-20T10:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("no-instance"),
        decision: "denied",
        instanceId: null,
        recordedAt: new Date("2026-10-20T11:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("imported-row"),
        decision: "denied",
        actorKind: "user",
        actorId: "alice",
        imported: true,
        instanceId: "remote-1",
        recordedAt: new Date("2026-10-20T12:00:00Z"),
      }),
    ]);

    const refusals = await reader.listRefusals({ since: SINCE }, null, 10);

    expect(refusals.map((row) => row.requestId)).toEqual(["no-instance", "api-instance"]);
  });

  it("lists a signed-in user's denial under the actor enforcement recorded, never an unauthenticated refusal", async () => {
    // The rows the HTTP kit now writes: a resolved caller refused by a check
    // is named on its row; a caller with no credential stays anonymous.
    await db.insert(requestLog).values([
      makeRequestLog({
        requestId: id("user-denied"),
        decision: "denied",
        actorKind: "user",
        actorId: "bob",
        permission: "orders_create",
        recordedAt: new Date("2026-10-20T10:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("unauthenticated"),
        decision: "unauthenticated",
        actorKind: "anonymous",
        actorId: "",
        recordedAt: new Date("2026-10-20T11:00:00Z"),
      }),
    ]);

    const refusals = await reader.listRefusals({ since: SINCE }, null, 10);
    const bobs = await reader.listRefusals({ since: SINCE, userId: "bob" }, null, 10);

    expect(refusals.map((row) => row.requestId)).toEqual(["user-denied"]);
    expect(refusals[0]).toMatchObject({
      actorKind: "user",
      actorId: "bob",
      decision: "denied",
      permission: "orders_create",
    });
    expect(bobs.map((row) => row.requestId)).toEqual(["user-denied"]);
  });

  it("pages refusals by cursor", async () => {
    await db.insert(requestLog).values([
      makeRequestLog({
        requestId: id("first"),
        decision: "denied",
        recordedAt: new Date("2026-10-20T10:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("second"),
        decision: "denied",
        recordedAt: new Date("2026-10-21T10:00:00Z"),
      }),
    ]);

    const [newest] = await reader.listRefusals({ since: SINCE }, null, 1);
    if (newest === undefined) throw new Error("expected a refusal");
    const older = await reader.listRefusals({ since: SINCE }, newest.cursor, 1);

    expect(newest.requestId).toBe("second");
    expect(older.map((row) => row.requestId)).toEqual(["first"]);
  });

  it("narrows refusals to the person behind them", async () => {
    await db.insert(requestLog).values([
      makeRequestLog({
        requestId: id("alice-direct"),
        decision: "denied",
        actorKind: "user",
        actorId: "alice",
        recordedAt: new Date("2026-10-20T10:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("automation-with-same-id"),
        decision: "denied",
        actorKind: "automation",
        actorId: "alice",
        recordedAt: new Date("2026-10-20T11:00:00Z"),
      }),
      makeRequestLog({
        requestId: id("bob"),
        decision: "denied",
        actorKind: "user",
        actorId: "bob",
        recordedAt: new Date("2026-10-20T12:00:00Z"),
      }),
    ]);

    const alice = await reader.listRefusals({ since: SINCE, userId: "alice" }, null, 10);

    expect(alice.map((row) => row.requestId)).toEqual(["alice-direct"]);
  });
});
