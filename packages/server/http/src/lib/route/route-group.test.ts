import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import { paginationQuerySchema } from "@dads-framework/contract";

import { createRateLimiter } from "../request-pipeline/rate-limit.js";
import { publicAccess, requireSession } from "./access.js";
import type { RawRouteDefinition } from "./define-raw-route.js";
import { getRoute } from "./get-route.js";
import { listRoute } from "./list-route.js";
import type { RouteDefinition } from "./route-definition.js";
import { routeGroup } from "./route-group.js";

/**
 * The always-a-group rule and the capability ladder (locked with Bryton,
 * 2026-07-09): tags are stamped once per group; group capabilities apply
 * across members; a route's own field overrides per key; blueprints are
 * NOT registrable until grouped (pinned at the type level).
 */

const thingSchema = z.object({ id: z.string() });

const blueprint = getRoute({
  route: { method: "GET", template: "/things/:id" },
  summary: "Get a thing",
  access: requireSession(),
  params: z.object({ id: z.string() }),
  response: thingSchema,
  handler: ({ params }) => ({ id: params.id }),
});

describe("routeGroup", () => {
  it("stamps the tag on every member", () => {
    const routes = routeGroup("Things", [blueprint]);
    expect(routes.map((route) => route.tag)).toEqual(["Things"]);
  });

  it("blueprints are not RouteDefinitions until grouped", () => {
    expectTypeOf(blueprint).not.toExtend<RouteDefinition>();
    expectTypeOf(routeGroup("Things", [blueprint])).toExtend<
      readonly (RouteDefinition | RawRouteDefinition)[]
    >();
  });

  it("applies group capabilities across members; route fields win per key", () => {
    const strict = getRoute({
      route: { method: "GET", template: "/strict" },
      summary: "Route-level override",
      access: publicAccess(),
      capabilities: { rateLimit: { perMinute: 1 } },
      response: thingSchema,
      handler: () => ({ id: "s" }),
    });
    const routes = routeGroup("Things", { rateLimit: { perMinute: 100 } }, [
      blueprint,
      strict,
    ]);
    expect(routes[0]?.capabilities.rateLimit).toEqual({ perMinute: 100 });
    expect(routes[1]?.capabilities.rateLimit).toEqual({ perMinute: 1 });
  });

  it("gives every member the group's site label; a route's own site label wins", () => {
    const writes = getRoute({
      route: { method: "GET", template: "/writes" },
      summary: "Route-level site label",
      access: requireSession(),
      capabilities: { site: "write_door" },
      response: thingSchema,
      handler: () => ({ id: "w" }),
    });
    const routes = routeGroup("Things", { site: "cloud_only" }, [
      blueprint,
      writes,
    ]);
    expect(routes.map((route) => route.capabilities.site)).toEqual([
      "cloud_only",
      "write_door",
    ]);
  });

  it("drops a group's cloud-only reason under a route's own label, and keeps a route's own reason", () => {
    const served = getRoute({
      route: { method: "GET", template: "/served" },
      summary: "Route-level served label",
      access: requireSession(),
      capabilities: { site: "served" },
      response: thingSchema,
      handler: () => ({ id: "s" }),
    });
    const ownReason = getRoute({
      route: { method: "GET", template: "/own-reason" },
      summary: "Route-level cloud-only label with its own reason",
      access: requireSession(),
      capabilities: {
        site: "cloud_only",
        cloudOnly: { reason: "NOT_YET", why: "Later.", ticket: "APP-1" },
      },
      response: thingSchema,
      handler: () => ({ id: "o" }),
    });
    const reasonOnly = getRoute({
      route: { method: "GET", template: "/reason-only" },
      summary: "Route-level reason under the group's cloud-only label",
      access: requireSession(),
      capabilities: {
        cloudOnly: { reason: "FLEET", why: "Device link." },
      },
      response: thingSchema,
      handler: () => ({ id: "r" }),
    });
    const repeatsLabel = getRoute({
      route: { method: "GET", template: "/repeats-label" },
      summary: "Route-level cloud-only label repeating the group's",
      access: requireSession(),
      capabilities: { site: "cloud_only" },
      response: thingSchema,
      handler: () => ({ id: "l" }),
    });
    const routes = routeGroup(
      "Things",
      {
        site: "cloud_only",
        cloudOnly: { reason: "STAFF_TOOLS", why: "Staff only." },
      },
      [blueprint, served, ownReason, reasonOnly, repeatsLabel],
    );

    expect(
      routes.map((route) => [
        route.capabilities.site,
        route.capabilities.cloudOnly,
      ]),
    ).toEqual([
      ["cloud_only", { reason: "STAFF_TOOLS", why: "Staff only." }],
      ["served", undefined],
      ["cloud_only", { reason: "NOT_YET", why: "Later.", ticket: "APP-1" }],
      ["cloud_only", { reason: "FLEET", why: "Device link." }],
      ["cloud_only", { reason: "STAFF_TOOLS", why: "Staff only." }],
    ]);
  });

  it("leaves the site label unset when neither the group nor the route sets it", () => {
    const routes = routeGroup("Things", [blueprint]);
    expect(routes[0]?.capabilities.site).toBeUndefined();
  });

  it("groups compose — two tags from one domain", () => {
    const imports = listRoute({
      route: { method: "GET", template: "/imports" },
      summary: "List imports",
      access: requireSession(),
      query: paginationQuerySchema,
      item: thingSchema,
      handler: () => ({ items: [], total: 0 }),
    });
    const routes = [
      ...routeGroup("Things", [blueprint]),
      ...routeGroup("Imports", [imports]),
    ];
    expect(routes.map((route) => route.tag)).toEqual(["Things", "Imports"]);
  });
});

describe("createRateLimiter", () => {
  it("enforces the fixed window per caller and reports retry-after", () => {
    let at = 0;
    const limiter = createRateLimiter({ perMinute: 2 }, () => at);
    expect(limiter.consume("GET /x", "u1").allowed).toBe(true);
    expect(limiter.consume("GET /x", "u1").allowed).toBe(true);
    const third = limiter.consume("GET /x", "u1");
    expect(third).toEqual({ allowed: false, retryAfterSeconds: 60 });
    // another caller is unaffected
    expect(limiter.consume("GET /x", "u2").allowed).toBe(true);
    // window reset restores budget
    at = 61_000;
    expect(limiter.consume("GET /x", "u1").allowed).toBe(true);
  });

  it("never shares budget across routes", () => {
    const limiter = createRateLimiter(
      { perMinute: 1 },
      vi.fn(() => 0),
    );
    expect(limiter.consume("GET /a", "u1").allowed).toBe(true);
    expect(limiter.consume("GET /b", "u1").allowed).toBe(true);
  });

  it("evicts expired callers so a churning flood cannot grow memory forever", () => {
    let at = 0;
    const limiter = createRateLimiter({ perMinute: 5 }, () => at);
    for (let caller = 0; caller < 1_000; caller += 1) {
      limiter.consume("GET /x", `flood-${caller}`);
    }
    expect(limiter.size()).toBe(1_000);
    // Two windows later the flood's entries are dead; the next consume sweeps
    // them, so the map holds only the callers of the current window.
    at = 2 * 60_000;
    limiter.consume("GET /x", "steady");
    expect(limiter.size()).toBe(1);
  });

  it("keeps live windows through a sweep, with their spent budget intact", () => {
    let at = 0;
    const limiter = createRateLimiter({ perMinute: 2 }, () => at);
    limiter.consume("GET /x", "early"); // window dies at 60s
    at = 30_000;
    limiter.consume("GET /x", "late"); // window lives until 90s
    limiter.consume("GET /x", "late");
    at = 61_000; // crossing the sweep threshold set at t=0
    limiter.consume("GET /x", "trigger"); // sweep: evicts early, keeps late
    expect(limiter.size()).toBe(2);
    expect(limiter.consume("GET /x", "late")).toEqual({
      allowed: false,
      retryAfterSeconds: 29,
    });
  });
});
