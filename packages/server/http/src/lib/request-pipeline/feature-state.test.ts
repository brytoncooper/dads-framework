import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";

import { errorBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { requireSession } from "../route/access.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import type {
  FeatureStateProtocol,
  FeatureStateSnapshot,
} from "./feature-state.js";
import { registerRoutes } from "./register-routes.js";

const subject: SubjectRef = { type: "user", id: "user-1" };
const snapshots: {
  readonly before: FeatureStateSnapshot;
  readonly after: FeatureStateSnapshot;
} = {
  before: { features: [], stateHash: "before" },
  after: { features: ["example.rollout"], stateHash: "after" },
};

let apps: { close: () => Promise<void> }[] = [];

/** The header names below are the application's, not the kit's. */
function protocol(read: () => "before" | "after"): FeatureStateProtocol {
  return {
    evaluator: { evaluate: () => Promise.resolve(snapshots[read()]) },
    hashHeader: "x-test-state-hash",
    clientHashHeader: "x-test-client-state-hash",
    contextHeader: "x-test-caller-context",
  };
}

async function buildApp(input: {
  readonly state: () => "before" | "after";
  readonly mutate: () => void;
}) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("Feature test", [
      postRoute({
        path: "/stateful-write",
        summary: "Changes test state",
        access: requireSession(),
        capabilities: { featureStateWrite: "sensitive" },
        response: z.object({ ok: z.boolean() }),
        handler: () => {
          input.mutate();
          return { ok: true };
        },
      }),
      postRoute({
        path: "/unrelated-write",
        summary: "Changes unrelated test state",
        access: requireSession(),
        response: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      }),
    ]),
    subjects: { resolve: () => Promise.resolve(subject) },
    authorization: { check: () => Promise.resolve(false) },
    featureState: protocol(input.state),
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("feature-state request pipeline", () => {
  it("returns the current hash and details on a stale write before its handler", async () => {
    let calls = 0;
    const app = await buildApp({
      state: () => "before",
      mutate: () => {
        calls += 1;
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/stateful-write",
      headers: { "x-test-client-state-hash": "stale" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers["x-test-state-hash"]).toBe("before");
    expect(errorBodyOf(response)).toMatchObject({
      code: "STALE_FEATURE_STATE",
      details: { currentFeatureStateHash: "before" },
    });
    expect(calls).toBe(0);
  });

  it("accepts a missing hash and overwrites a successful write response with its post-write hash", async () => {
    let state: "before" | "after" = "before";
    const app = await buildApp({
      state: () => state,
      mutate: () => {
        state = "after";
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/stateful-write",
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["x-test-state-hash"]).toBe("after");
  });

  it("does not reject an unrelated write when its supplied feature-state hash is stale", async () => {
    const app = await buildApp({
      state: () => "before",
      mutate: () => undefined,
    });
    const response = await app.inject({
      method: "POST",
      url: "/unrelated-write",
      headers: { "x-test-client-state-hash": "stale" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["x-test-state-hash"]).toBe("before");
  });
});
