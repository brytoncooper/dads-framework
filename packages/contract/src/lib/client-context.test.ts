/**
 * What: `x-client-context` round-trips a web or kiosk debugging blob through
 * base64url JSON, and `decodeClientContext` returns `null` — never throws —
 * for every way a client-sent header can be wrong.
 * Why: ADR-0112 requires this header can never fail a request. A decode that
 * throws on a hostile or merely stale client would turn a debugging header
 * into an outage; every failure mode here must degrade to `null` instead.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_CONTEXT_HEADER,
  CLIENT_CONTEXT_MAX_BYTES,
  clientContextSchema,
  decodeClientContext,
  encodeClientContext,
  type ClientContext,
} from "./client-context.js";

const webContext: ClientContext = {
  version: 1,
  client: "web",
  build: "2026.09.10-1",
  timeZone: "America/Chicago",
  locale: "en-US",
  routeId: "/orgs/:organizationSlug/facilities/:facilitySlug/operate",
  viewport: { w: 1728, h: 1117, dpr: 2 },
  screen: { w: 1728, h: 1117 },
  touch: false,
  online: true,
  connection: "4g",
  deviceMemory: 8,
  hardwareConcurrency: 10,
  tabAgeMs: 452_000,
};

const kioskContext: ClientContext = {
  version: 1,
  client: "kiosk",
  build: "2026.09.10-1",
  timeZone: "America/Chicago",
  locale: "en-US",
  os: "Raspberry Pi OS 12",
  electron: "32.1.0",
  hostname: "scale-3-north-mill",
  deviceId: "edge-device-000000000042",
  outboxDepth: 3,
  lastPullAt: "2026-09-10T14:03:00.000Z",
  clockSkewMs: -120,
};

describe("CLIENT_CONTEXT_HEADER", () => {
  it("names the header ADR-0112 assigns to this context", () => {
    expect(CLIENT_CONTEXT_HEADER).toBe("x-client-context");
  });
});

describe("encodeClientContext / decodeClientContext", () => {
  it("round-trips a web context", () => {
    expect(decodeClientContext(encodeClientContext(webContext))).toEqual(
      webContext,
    );
  });

  it("round-trips a kiosk context, kiosk-only fields included", () => {
    expect(decodeClientContext(encodeClientContext(kioskContext))).toEqual(
      kioskContext,
    );
  });

  it("returns null for an undefined header", () => {
    expect(decodeClientContext(undefined)).toBeNull();
  });

  it("returns null for a header longer than CLIENT_CONTEXT_MAX_BYTES", () => {
    const oversized = "A".repeat(CLIENT_CONTEXT_MAX_BYTES + 1);
    expect(decodeClientContext(oversized)).toBeNull();
  });

  it("returns null for a value that is not valid base64url", () => {
    expect(
      decodeClientContext("not base64url! (has spaces + punctuation)"),
    ).toBeNull();
  });

  it("returns null for valid base64url that is not JSON", () => {
    const notJson = encodeToBase64UrlForTest("this is not json");
    expect(decodeClientContext(notJson)).toBeNull();
  });

  it("returns null for JSON that fails the strict schema (unmodelled key)", () => {
    const withExtraKey = { ...webContext, unexpectedField: "surprise" };
    const encoded = encodeToBase64UrlForTest(JSON.stringify(withExtraKey));
    expect(decodeClientContext(encoded)).toBeNull();
  });

  it("returns null for a version this schema does not recognize", () => {
    const wrongVersion = { ...webContext, version: 2 };
    const encoded = encodeToBase64UrlForTest(JSON.stringify(wrongVersion));
    expect(decodeClientContext(encoded)).toBeNull();
  });

  it("accepts routeId as the matched route template", () => {
    const decoded = decodeClientContext(encodeClientContext(webContext));
    expect(decoded?.routeId).toBe(
      "/orgs/:organizationSlug/facilities/:facilitySlug/operate",
    );
  });

  it("treats routeId as a plain bounded string, not a validated path shape", () => {
    // The schema only bounds length. Callers are trusted to pass a route
    // template (e.g. "/orders/:orderId"), never a raw path with real ids —
    // the same discipline `request_log` itself follows — but a
    // raw-looking path is not rejected here; nothing downstream of the
    // schema can tell the difference.
    const rawLookingPath: ClientContext = {
      ...webContext,
      routeId: "/orders/1e8f0a9e-3f2b-4c6d-9a1e-000000000001",
    };
    expect(clientContextSchema.safeParse(rawLookingPath).success).toBe(true);
  });
});

/** Encodes arbitrary text as base64url, bypassing the JSON contract — for building malformed fixtures only. */
function encodeToBase64UrlForTest(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
