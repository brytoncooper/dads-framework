/**
 * What: a reported fault becomes a row whose identity and timing are the
 * server's, not the report's.
 * Why: this route is public, so every field on the way in is a claim. The
 * three rules here are the ones that would be silently exploitable if they
 * were wrong — a client choosing its own actor, its own row id, or passing its
 * clock off as ours.
 */

import { describe, expect, it } from "vitest";

import type { ClientDiagnosticEvent } from "@dads-framework/core/contract";

import { clientDiagnosticEventIdSchema } from "../client-diagnostic-event.ids.js";
import { clientDiagnosticRow } from "./client-diagnostic-row.js";

/** A deterministic, valid-shaped id per label — the format the schema requires. */
const ID_1 = clientDiagnosticEventIdSchema.parse("00000001-0000-7000-8000-000000000001");
const ID_2 = clientDiagnosticEventIdSchema.parse("00000001-0000-7000-8000-000000000002");
const MINTED_BY_THE_SERVER = clientDiagnosticEventIdSchema.parse("00000001-0000-7000-8000-0000000000f1");

const EVENT: ClientDiagnosticEvent = {
  version: 1,
  occurredAt: "2026-09-14T10:00:00.000Z",
  fingerprint: "a1b2c3",
  kind: "render",
  severity: "error",
  name: "TypeError",
  message: "cannot read properties of undefined",
  frames: [{ function: "OrderTable", file: "/assets/orders.js", line: 42 }],
  breadcrumbs: [],
  release: "0192f2a0",
};

describe("clientDiagnosticRow", () => {
  it("takes the actor from the request, never from the report", () => {
    const row = clientDiagnosticRow({
      event: EVENT,
      actor: { kind: "user", id: "user-1" },
      id: ID_1,
    });

    expect(row).toMatchObject({ actorKind: "user", actorId: "user-1" });
  });

  it("records an anonymous report rather than refusing it", () => {
    // A fault on the login page is exactly what this route exists to hear.
    const row = clientDiagnosticRow({
      event: EVENT,
      actor: { kind: "anonymous", id: "" },
      id: ID_1,
    });

    expect(row).toMatchObject({ actorKind: "anonymous", actorId: "" });
  });

  it("uses the id it was given, not one the report chose", () => {
    const row = clientDiagnosticRow({
      event: EVENT,
      actor: { kind: "anonymous", id: "" },
      id: MINTED_BY_THE_SERVER,
    });

    expect(row.id).toBe(MINTED_BY_THE_SERVER);
  });

  it("keeps the client's clock as the client's clock", () => {
    const row = clientDiagnosticRow({
      event: EVENT,
      actor: { kind: "anonymous", id: "" },
      id: ID_1,
    });

    expect(row.occurredAt).toEqual(new Date("2026-09-14T10:00:00.000Z"));
  });

  it("says which client reported, and says unknown when it cannot tell", () => {
    const withContext = clientDiagnosticRow({
      event: {
        ...EVENT,
        context: {
          version: 1,
          client: "kiosk",
          build: "1.4.0",
          timeZone: "America/Chicago",
          locale: "en-US",
        },
      },
      actor: { kind: "device", id: "device-1" },
      id: ID_1,
    });
    const withoutContext = clientDiagnosticRow({
      event: EVENT,
      actor: { kind: "anonymous", id: "" },
      id: ID_2,
    });

    expect(withContext.client).toBe("kiosk");
    // A fault early enough to precede the context provider still gets stored.
    expect(withoutContext.client).toBe("unknown");
    expect(withoutContext.context).toBeNull();
  });

  it("carries the request id that joins this fault to its request", () => {
    const row = clientDiagnosticRow({
      event: { ...EVENT, requestId: "req-42" },
      actor: { kind: "user", id: "user-1" },
      id: ID_1,
    });

    expect(row.requestId).toBe("req-42");
  });
});
