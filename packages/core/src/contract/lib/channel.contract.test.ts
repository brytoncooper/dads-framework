import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelEnvelopeSchema } from "./channel.schema.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8"));
}

describe("channel envelope contract", () => {
  it("parses the committed fixture", () => {
    expect(() => channelEnvelopeSchema.parse(fixture("channel-envelope.json"))).not.toThrow();
  });

  it("survives serialization round-trips", () => {
    const envelope = channelEnvelopeSchema.parse(fixture("channel-envelope.json"));
    const roundTripped: unknown = JSON.parse(JSON.stringify(envelope));
    expect(() => channelEnvelopeSchema.parse(roundTripped)).not.toThrow();
  });

  it("rejects undeclared envelope keys and preserves the domain payload", () => {
    const payload = { station: { inputs: [true, false] } };
    const envelope = {
      channel: "plc.tags",
      seq: 0,
      at: "2026-07-10T12:00:00.000Z",
      payload,
    };
    expect(channelEnvelopeSchema.parse(envelope).payload).toEqual(payload);
    expect(channelEnvelopeSchema.safeParse({ ...envelope, source: "plc" }).success).toBe(false);
  });

  it("rejects unnamespaced channel names (domains own their prefix)", () => {
    const flat = {
      channel: "tags",
      seq: 0,
      at: "2026-07-10T12:00:00.000Z",
      payload: {},
    };
    expect(channelEnvelopeSchema.safeParse(flat).success).toBe(false);
  });
});
