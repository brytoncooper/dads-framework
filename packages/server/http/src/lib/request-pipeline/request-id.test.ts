import { describe, expect, it } from "vitest";
import { resolveRequestId } from "./request-id.js";

describe("resolveRequestId", () => {
  it("honors a sane inbound id untouched", () => {
    expect(resolveRequestId("req-abc-123")).toEqual({
      id: "req-abc-123",
      generated: false,
    });
  });

  it("trims surrounding whitespace and caps a hostile id at 128 chars", () => {
    const resolved = resolveRequestId(`  ${"x".repeat(500)}  `);
    expect(resolved.generated).toBe(false);
    expect(resolved.id).toBe("x".repeat(128));
  });

  it("mints an id when the header is blank", () => {
    const resolved = resolveRequestId("   ");
    expect(resolved.generated).toBe(true);
    expect(resolved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("mints an id when the header is missing or not a string", () => {
    for (const header of [undefined, null, 42, ["spoofed", "twice"]]) {
      expect(resolveRequestId(header).generated).toBe(true);
    }
  });

  it("mints a fresh id per request, never a shared one", () => {
    expect(resolveRequestId(undefined).id).not.toBe(resolveRequestId(undefined).id);
  });
});
