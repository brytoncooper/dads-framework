/**
 * What/why: a list refetch after a write must not fall back to SpiceDB's
 * minimize-latency snapshot when a consistency token is available — that is
 * the stale-after-create bug on a real SpiceDB datastore.
 */
import { describe, expect, it } from "vitest";
import { resolveReadConsistency } from "@dads-framework/access/runtime";

describe("resolveReadConsistency", () => {
  it("uses the write token so a refetch cannot see a snapshot older than that write", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "minimize-latency",
        queryToken: "written-at-3",
      }),
    ).toEqual({ kind: "at-least-as-fresh", token: "written-at-3" });
  });

  it("uses the request watermark when the caller did not pass a token", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "minimize-latency",
        requestToken: "cookie-token",
      }),
    ).toEqual({ kind: "at-least-as-fresh", token: "cookie-token" });
  });

  it("prefers an explicit query token over the request watermark", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "minimize-latency",
        queryToken: "query-token",
        requestToken: "cookie-token",
      }),
    ).toEqual({ kind: "at-least-as-fresh", token: "query-token" });
  });

  it("keeps minimize-latency when no token has been written or carried", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "minimize-latency",
      }),
    ).toEqual({ kind: "minimize-latency" });
  });

  it("ignores empty tokens", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "minimize-latency",
        queryToken: "",
        requestToken: "",
      }),
    ).toEqual({ kind: "minimize-latency" });
  });

  it("a fully-consistent adapter stays fully-consistent even when a token is present", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "fully-consistent",
        queryToken: "written-at-3",
      }),
    ).toEqual({ kind: "fully-consistent" });
  });

  it("a fully-consistent query stays fully-consistent", () => {
    expect(
      resolveReadConsistency({
        adapterConsistency: "minimize-latency",
        queryConsistency: "fully-consistent",
        requestToken: "cookie-token",
      }),
    ).toEqual({ kind: "fully-consistent" });
  });
});
