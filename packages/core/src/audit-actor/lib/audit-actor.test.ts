import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_ACTOR_SETTING,
  auditActorSchema,
  parseAuditActor,
  serializeAuditActor,
  type AuditActor,
} from "./audit-actor.js";

const REQUEST_ID = "01990000-0000-7000-8000-000000000001";

/**
 * What the setting actually holds: a flat JSON object whose keys and their
 * order are the thing under test. Parsed through a schema rather than read
 * straight off `JSON.parse`, so the assertions below stand on a typed value
 * instead of an untyped one.
 */
const storedFieldsSchema = z.record(z.string(), z.unknown());

function storedFields(stored: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(stored);
  return storedFieldsSchema.parse(decoded);
}

describe("auditActorSchema", () => {
  it("accepts every kind the audit log admits", () => {
    for (const kind of AUDIT_ACTOR_KINDS) {
      const parsed = auditActorSchema.safeParse({
        kind,
        id: "actor-1",
        requestId: REQUEST_ID,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("accepts the integration kind", () => {
    const parsed = auditActorSchema.safeParse({
      kind: "integration",
      id: "connection-1",
      requestId: REQUEST_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the optional annotations", () => {
    const parsed = auditActorSchema.parse({
      kind: "operator",
      id: "staff-1",
      requestId: REQUEST_ID,
      reason: "customer asked",
    });
    expect(parsed.reason).toBe("customer asked");
  });

  it("round-trips an application actor kind", () => {
    const actor = {
      kind: "inventory_robot",
      id: "robot-1",
      requestId: REQUEST_ID,
    };
    expect(parseAuditActor(serializeAuditActor(actor))).toEqual(actor);
  });

  it.each(["", "robot !", "unattributed"])("rejects invalid actor kind %s", (kind) => {
    expect(
      auditActorSchema.safeParse({
        kind,
        id: "actor-1",
        requestId: REQUEST_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key rather than dropping it", () => {
    expect(
      auditActorSchema.safeParse({
        kind: "user",
        id: "user-1",
        requestId: REQUEST_ID,
        untrustedField: "value",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty request id, which would attribute a row to nothing", () => {
    expect(auditActorSchema.safeParse({ kind: "user", id: "user-1", requestId: "" }).success).toBe(false);
  });

  it("rejects a reason longer than the column admits", () => {
    expect(
      auditActorSchema.safeParse({
        kind: "user",
        id: "user-1",
        requestId: REQUEST_ID,
        reason: "x".repeat(513),
      }).success,
    ).toBe(false);
  });
});

describe("serializeAuditActor and parseAuditActor", () => {
  it("round trips an actor carrying every field", () => {
    const actor: AuditActor = {
      kind: "integration",
      id: "org-1/account-1",
      requestId: REQUEST_ID,
      reason: "bulk import",
      clientId: "client-1",
      clientName: "Claude",
    };

    expect(parseAuditActor(serializeAuditActor(actor))).toEqual(actor);
  });

  it("omits absent optionals from the stored string", () => {
    const stored = serializeAuditActor({
      kind: "system",
      id: "migration",
      requestId: REQUEST_ID,
    });

    expect(storedFields(stored)).toEqual({
      kind: "system",
      id: "migration",
      requestId: REQUEST_ID,
    });
  });

  it("stores the keys the trigger reads", () => {
    const stored = serializeAuditActor({
      kind: "staff",
      id: "staff-1",
      requestId: REQUEST_ID,
      reason: "escalation",
    });

    expect(Object.keys(storedFields(stored))).toEqual(["kind", "id", "requestId", "reason"]);
  });

  it("stores the OAuth client a person acted through under the keys the trigger reads", () => {
    const stored = serializeAuditActor({
      kind: "user",
      id: "user-1",
      requestId: REQUEST_ID,
      clientId: "client-1",
      clientName: "ChatGPT",
    });

    expect(storedFields(stored)).toEqual({
      kind: "user",
      id: "user-1",
      requestId: REQUEST_ID,
      clientId: "client-1",
      clientName: "ChatGPT",
    });
  });

  it.each([
    ["an empty setting", ""],
    ["malformed json", "{not json"],
    ["a shape from another vocabulary", '{"actor_type":"USER"}'],
  ])("reads %s back as null", (_label, stored) => {
    expect(parseAuditActor(stored)).toBeNull();
  });
});

describe("AUDIT_ACTOR_SETTING", () => {
  it("names the setting the migration's trigger reads", () => {
    expect(AUDIT_ACTOR_SETTING).toBe("dads.audit_actor");
  });
});
