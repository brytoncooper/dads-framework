/**
 * WHAT: the pure row builder — which headers it is allowed to read, what it
 * puts in `path`, and how a status plus an access outcome become one decision.
 *
 * WHY: this file decides what leaves the process and lands in a table kept for
 * 90 days. The redaction rules (docs/architecture/observability.md) are only
 * as good as its allowlist, so these tests assert the NEGATIVE — an
 * authorization header, a cookie, and a raw resource id are absent from the
 * whole record, not merely from the field someone remembered to check.
 */
import { describe, expect, it } from "vitest";

import {
  encodeClientContext,
  CLIENT_CONTEXT_HEADER,
} from "@dads-framework/core/contract";

import {
  buildRequestRecord,
  type RequestRecordInput,
} from "./request-record.js";

const RESOURCE_ID = "01JQZ0000000000000000ORDER";
const SESSION_COOKIE = "example.session=super-secret-session-value";
const BEARER = "Bearer super-secret-token";

function input(
  overrides: Partial<RequestRecordInput> = {},
): RequestRecordInput {
  return {
    requestId: "request-1",
    recordedAt: new Date("2026-09-11T00:00:00.000Z"),
    method: "POST",
    url: `/api/organizations/${RESOURCE_ID}/orders?include=lines`,
    routePattern: "/api/organizations/:organizationId/orders",
    status: 201,
    durationMs: 12,
    headers: {},
    ip: "203.0.113.10",
    actor: { kind: "user", id: "user-1", requestId: "request-1" },
    access: { outcome: "allow", accessKind: "permission" },
    errorCode: undefined,
    apiRelease: undefined,
    work: undefined,
    instanceId: undefined,
    traceId: undefined,
    exception: undefined,
    ...overrides,
  };
}

describe("buildRequestRecord", () => {
  it("carries the trace this request belonged to", () => {
    const record = buildRequestRecord(
      input({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }),
    );

    expect(record.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("leaves the trace null when nothing was tracing", () => {
    // The normal state for an offline deployment. The row and its work
    // counters are complete without it, because they were never sampled.
    expect(buildRequestRecord(input()).traceId).toBeNull();
  });

  it("records what failed, not just that something did", () => {
    // `errorCode` is INTERNAL_ERROR for every unexpected fault — exactly the
    // set worth investigating and exactly the set it cannot tell apart.
    const record = buildRequestRecord(
      input({
        status: 500,
        errorCode: "INTERNAL_ERROR",
        exception: { type: "TypeError", fingerprint: "a1b2c3d4" },
      }),
    );

    expect(record).toMatchObject({
      errorCode: "INTERNAL_ERROR",
      exceptionType: "TypeError",
      exceptionFingerprint: "a1b2c3d4",
    });
  });

  it("stores no exception on a request that did not fail", () => {
    const record = buildRequestRecord(input());

    expect(record).toMatchObject({
      exceptionType: null,
      exceptionFingerprint: null,
    });
  });

  it("records what the request cost when the counters ran", () => {
    const record = buildRequestRecord(
      input({
        work: {
          dbQueryCount: 41,
          dbMs: 86.4,
          authzCheckCount: 40,
          authzMs: 512.6,
          authzCachedReadCount: 38,
          authzFullyConsistentReadCount: 2,
          authzLargestLookupCount: 1_204,
          authzWarning: undefined,
        },
        instanceId: "ip-10-0-1-23",
      }),
    );

    // Rounded, because the column is an integer and a fractional millisecond
    // is below the resolution any of these questions are asked at.
    expect(record).toMatchObject({
      dbQueryCount: 41,
      dbMs: 86,
      authzCheckCount: 40,
      authzMs: 513,
      authzCachedReadCount: 38,
      authzFullyConsistentReadCount: 2,
      authzLargestLookupCount: 1_204,
      instanceId: "ip-10-0-1-23",
    });
  });

  it("leaves the cost null when nothing measured it", () => {
    // A build without the counters, or a response that never started a tally.
    // Null reads as "not measured"; zero would claim the request did no work.
    const record = buildRequestRecord(input());

    expect(record).toMatchObject({
      dbQueryCount: null,
      dbMs: null,
      authzCheckCount: null,
      authzMs: null,
      authzCachedReadCount: null,
      authzFullyConsistentReadCount: null,
      authzLargestLookupCount: null,
      instanceId: null,
    });
  });

  it("stores the route pattern as the path and never the raw url", () => {
    const record = buildRequestRecord(input());

    expect(record.routeId).toBe("/api/organizations/:organizationId/orders");
    expect(record.path).toBe("/api/organizations/:organizationId/orders");
    expect(JSON.stringify(record)).not.toContain(RESOURCE_ID);
    expect(JSON.stringify(record)).not.toContain("include=lines");
  });

  it("masks the identifying segments when no route matched, so a 404 still names where it went", () => {
    const record = buildRequestRecord(
      input({
        routePattern: undefined,
        url: `/api/orders/${RESOURCE_ID}/lines?page=2`,
        status: 404,
        access: undefined,
      }),
    );

    expect(record.routeId).toBeNull();
    expect(record.path).toBe("/api/orders/:id/lines");
    expect(JSON.stringify(record)).not.toContain(RESOURCE_ID);
  });

  it("reads only the allowlisted headers — authorization and cookie reach nothing", () => {
    const record = buildRequestRecord(
      input({
        headers: {
          authorization: BEARER,
          cookie: SESSION_COOKIE,
          "x-api-key": "another-secret",
          "user-agent": "Mozilla/5.0 (Macintosh)",
          "accept-language": "en-US,en;q=0.9",
          "x-forwarded-for": "203.0.113.10, 198.51.100.1",
          "sec-ch-ua-platform": '"macOS"',
          "sec-ch-ua-mobile": "?0",
          referer: "https://example.test/orders",
        },
      }),
    );

    expect(record.userAgent).toBe("Mozilla/5.0 (Macintosh)");
    expect(record.acceptLanguage).toBe("en-US,en;q=0.9");
    expect(record.forwardedFor).toBe("203.0.113.10, 198.51.100.1");
    expect(record.clientHints).toEqual({
      "sec-ch-ua-platform": '"macOS"',
      "sec-ch-ua-mobile": "?0",
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-session-value");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("example.test");
  });

  it("has no client hints and no language when the request sent none", () => {
    const record = buildRequestRecord(
      input({ headers: { cookie: SESSION_COOKIE } }),
    );

    expect(record.clientHints).toBeNull();
    expect(record.acceptLanguage).toBeNull();
    expect(record.userAgent).toBeNull();
    expect(record.forwardedFor).toBeNull();
  });

  it("decodes a well-formed client context header", () => {
    const context = {
      version: 1,
      client: "web",
      build: "2026.09.11",
      timeZone: "America/Chicago",
      locale: "en-US",
      routeId: "/orders/$orderId",
    } as const;

    const record = buildRequestRecord(
      input({
        headers: { [CLIENT_CONTEXT_HEADER]: encodeClientContext(context) },
      }),
    );

    expect(record.clientContext).toEqual(context);
  });

  it("stores a null client context for garbage and for an oversized header", () => {
    const garbage = buildRequestRecord(
      input({ headers: { [CLIENT_CONTEXT_HEADER]: "not-base64-json!!!" } }),
    );
    const oversized = buildRequestRecord(
      input({ headers: { [CLIENT_CONTEXT_HEADER]: "a".repeat(5000) } }),
    );

    expect(garbage.clientContext).toBeNull();
    expect(oversized.clientContext).toBeNull();
  });

  it("carries the actor, the release, and the settled access facts", () => {
    const record = buildRequestRecord(
      input({
        apiRelease: "sha256:abc",
        actor: {
          kind: "staff",
          id: "staff-1",
          requestId: "request-1",
        },
        access: {
          outcome: "allow",
          accessKind: "permission",
          permission: "orders.create",
          resourceType: "organizations/organization",
          resourceId: "org-1",
          authMethod: "session-cookie",
        },
      }),
    );

    expect(record).toMatchObject({
      requestId: "request-1",
      method: "POST",
      status: 201,
      durationMs: 12,
      actorKind: "staff",
      actorId: "staff-1",
      authMethod: "session-cookie",
      accessKind: "permission",
      permission: "orders.create",
      resourceType: "organizations/organization",
      resourceId: "org-1",
      apiRelease: "sha256:abc",
      ip: "203.0.113.10",
      decision: "allow",
    });
  });

  it("falls back to an anonymous actor when the request never entered a context", () => {
    const record = buildRequestRecord(input({ actor: undefined }));

    expect(record.actorKind).toBe("anonymous");
    expect(record.actorId).toBe("");
  });

  it("maps status and access outcome onto one decision", () => {
    const decisionFor = (
      status: number,
      access: RequestRecordInput["access"],
    ): string => buildRequestRecord(input({ status, access })).decision;

    expect(
      decisionFor(201, { outcome: "allow", accessKind: "permission" }),
    ).toBe("allow");
    expect(
      decisionFor(404, { outcome: "not-found", accessKind: "permission" }),
    ).toBe("denied");
    expect(
      decisionFor(401, { outcome: "unauthenticated", accessKind: "session" }),
    ).toBe("unauthenticated");
    expect(decisionFor(404, undefined)).toBe("not-found");
    expect(decisionFor(403, undefined)).toBe("denied");
    expect(
      decisionFor(400, { outcome: "allow", accessKind: "permission" }),
    ).toBe("error");
    expect(
      decisionFor(429, { outcome: "allow", accessKind: "permission" }),
    ).toBe("error");
    expect(
      decisionFor(500, { outcome: "allow", accessKind: "permission" }),
    ).toBe("error");
  });

  it("keeps the error code the response envelope reported", () => {
    const record = buildRequestRecord(
      input({ status: 400, errorCode: "VALIDATION_FAILED" }),
    );

    expect(record.errorCode).toBe("VALIDATION_FAILED");
  });

  it("bounds every header value it stores, so one absurd user agent cannot bloat a row", () => {
    const record = buildRequestRecord(
      input({
        headers: {
          "user-agent": "u".repeat(4000),
          "sec-ch-ua": "h".repeat(4000),
        },
      }),
    );

    expect(record.userAgent?.length).toBe(512);
    expect(record.clientHints?.["sec-ch-ua"]?.length).toBe(512);
  });

  it("takes the first value of a repeated header rather than a joined array", () => {
    const record = buildRequestRecord(
      input({ headers: { "user-agent": ["first-agent", "second-agent"] } }),
    );

    expect(record.userAgent).toBe("first-agent");
  });
});
