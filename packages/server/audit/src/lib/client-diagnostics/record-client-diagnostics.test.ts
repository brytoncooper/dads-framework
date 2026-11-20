import { FakeAuthorization } from "@dads-framework/authorization/testing";
import { buildTestApp } from "@dads-framework/http/testing";
/**
 * What: recording a fault never becomes a second fault.
 * Why: a client reporting an error is already having a bad time. If storage
 * failed and this answered 500, a reporter that retries would report the
 * failure to report — a loop that turns one browser error into sustained load
 * on the database that is already unhappy. It answers zero accepted instead.
 */

import { describe, expect, it } from "vitest";

import type { ClientDiagnosticEvent } from "@dads-framework/contract";

import {
  type ClientDiagnosticRow,
  ClientDiagnosticWriter,
} from "../database/writers/client-diagnostic-writer.interface.js";
import { ClientDiagnosticsRouteHandlers } from "./client-diagnostics.route-handlers.js";
import { createClientDiagnosticsRoutes } from "./client-diagnostics.routes.js";
import { RecordClientDiagnostics } from "./record-client-diagnostics.js";

const EVENT: ClientDiagnosticEvent = {
  version: 1,
  occurredAt: "2026-09-14T10:00:00.000Z",
  fingerprint: "a1b2c3",
  kind: "render",
  severity: "error",
  name: "TypeError",
  message: "boom",
  frames: [],
  breadcrumbs: [],
  release: "0192f2a0",
};

class RecordingWriter extends ClientDiagnosticWriter {
  readonly recorded: ClientDiagnosticRow[][] = [];
  failWith: Error | undefined = undefined;

  override record(rows: readonly ClientDiagnosticRow[]): Promise<number> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.recorded.push([...rows]);
    return Promise.resolve(rows.length);
  }
  override deleteRecordedBefore(): Promise<number> {
    return Promise.resolve(0);
  }
}

function silentLog() {
  const entries: object[] = [];
  return {
    entries,
    error(entry: object): void {
      entries.push(entry);
    },
  };
}

describe("RecordClientDiagnostics", () => {
  it("stores a batch as one write and reports what landed", () => {
    const writer = new RecordingWriter();
    const recorder = new RecordClientDiagnostics(writer, silentLog());

    return recorder
      .execute({
        events: [EVENT, { ...EVENT, fingerprint: "d4e5f6" }],
        actor: { kind: "user", id: "user-1" },
      })
      .then((result) => {
        expect(result).toEqual({ accepted: 2 });
        expect(writer.recorded).toHaveLength(1);
        expect(writer.recorded[0]).toHaveLength(2);
      });
  });

  it("mints a distinct id for every event in a batch", async () => {
    const writer = new RecordingWriter();
    const recorder = new RecordClientDiagnostics(writer, silentLog());

    await recorder.execute({
      events: [EVENT, EVENT, EVENT],
      actor: { kind: "anonymous", id: "" },
    });

    const ids = writer.recorded[0]?.map((row) => row.id) ?? [];
    expect(new Set(ids).size).toBe(3);
  });

  it("answers zero accepted when storage failed, and never throws", async () => {
    const writer = new RecordingWriter();
    writer.failWith = new Error("relation does not exist");
    const log = silentLog();
    const recorder = new RecordClientDiagnostics(writer, log);

    const result = await recorder.execute({
      events: [EVENT],
      actor: { kind: "anonymous", id: "" },
    });

    expect(result).toEqual({ accepted: 0 });
    expect(log.entries[0]).toMatchObject({
      event: "client-diagnostics.store-failed",
    });
  });
});

it("accepts an anonymous diagnostic and refuses client-supplied attribution", async () => {
  const writer = new RecordingWriter();
  const handlers = new ClientDiagnosticsRouteHandlers(
    new RecordClientDiagnostics(writer, silentLog()),
  );
  const app = await buildTestApp({
    routes: createClientDiagnosticsRoutes(handlers),
    authorization: new FakeAuthorization({}),
  });
  try {
    const spoofed = await app.inject({
      method: "POST",
      url: "/client-diagnostics",
      payload: { events: [{ ...EVENT, actorKind: "administrator" }] },
    });
    expect(spoofed.statusCode).toBe(400);
    expect(writer.recorded).toEqual([]);

    const report = await app.inject({
      method: "POST",
      url: "/client-diagnostics",
      payload: { events: [EVENT] },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toEqual({ data: { accepted: 1 } });
    expect(writer.recorded).toEqual([
      [expect.objectContaining({ actorKind: "anonymous", actorId: "" })],
    ]);
  } finally {
    await app.close();
  }
});
