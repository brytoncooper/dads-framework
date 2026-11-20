import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";

import { errorBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { requireSession } from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import type { FeatureStateProtocol } from "./feature-state.js";
import {
  currentFeatureStatePreview,
  type FeatureStatePreview,
} from "./feature-state-preview.js";
import { registerRoutes } from "./register-routes.js";

const subject: SubjectRef = { type: "user", id: "user-1" };
const PREVIEW_HEADER = "x-test-preview";
const DROPPED_HEADER = "x-test-preview-dropped";
const viewOnly: FeatureStatePreview = {
  feature: "example.rollout",
  active: true,
  allowsWrites: false,
};

let apps: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

/** Header names and the resolver are the application's, not the kit's. */
function protocol(input: {
  readonly previews: Readonly<Record<string, FeatureStatePreview>>;
  readonly resolved: string[];
}): FeatureStateProtocol {
  return {
    evaluator: {
      evaluate: () => {
        const preview = currentFeatureStatePreview();
        return Promise.resolve({
          features: preview?.active ? [preview.feature] : [],
          stateHash: preview?.active ? "previewing" : "plain",
        });
      },
    },
    hashHeader: "x-test-state-hash",
    clientHashHeader: "x-test-client-state-hash",
    contextHeader: "x-test-caller-context",
    preview: {
      requestHeader: PREVIEW_HEADER,
      droppedHeader: DROPPED_HEADER,
      resolver: {
        resolve: ({ previewId, authenticatedSubject }) => {
          input.resolved.push(`${authenticatedSubject.id}:${previewId}`);
          return Promise.resolve(input.previews[previewId] ?? null);
        },
      },
    },
  };
}

async function buildApp(input: {
  readonly previews: Readonly<Record<string, FeatureStatePreview>>;
  readonly resolved?: string[];
  readonly writes?: string[];
}) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  const writes = input.writes ?? [];
  registerRoutes(app, {
    routes: routeGroup("Preview test", [
      getRoute({
        path: "/read",
        summary: "Reads the preview the handler runs inside",
        access: requireSession(),
        response: z.object({ feature: z.string().nullable() }),
        handler: () => ({
          feature: currentFeatureStatePreview()?.feature ?? null,
        }),
      }),
      postRoute({
        path: "/write",
        summary: "An ordinary write",
        access: requireSession(),
        response: z.object({ ok: z.boolean() }),
        handler: () => {
          writes.push("write");
          return { ok: true };
        },
      }),
      postRoute({
        path: "/preview-control",
        summary: "A write that manages the preview itself",
        access: requireSession(),
        capabilities: { writesDuringFeaturePreview: "allowed" },
        response: z.object({ ok: z.boolean() }),
        handler: () => {
          writes.push("preview-control");
          return { ok: true };
        },
      }),
    ]),
    subjects: { resolve: () => Promise.resolve(subject) },
    authorization: { check: () => Promise.resolve(false) },
    featureState: protocol({
      previews: input.previews,
      resolved: input.resolved ?? [],
    }),
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe("feature preview request pipeline", () => {
  it("carries a live preview into the snapshot and the handler", async () => {
    const resolved: string[] = [];
    const app = await buildApp({ previews: { p1: viewOnly }, resolved });

    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: { [PREVIEW_HEADER]: "p1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { feature: "example.rollout" } });
    expect(response.headers["x-test-state-hash"]).toBe("previewing");
    expect(response.headers[DROPPED_HEADER]).toBeUndefined();
    expect(resolved).toEqual(["user-1:p1"]);
  });

  it("answers an unknown preview id as no preview and tells the client to drop it", async () => {
    const app = await buildApp({ previews: {} });

    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: { [PREVIEW_HEADER]: "gone" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { feature: null } });
    expect(response.headers["x-test-state-hash"]).toBe("plain");
    expect(response.headers[DROPPED_HEADER]).toBe("1");
  });

  it("never resolves a request that carries no preview id", async () => {
    const resolved: string[] = [];
    const app = await buildApp({ previews: { p1: viewOnly }, resolved });

    const response = await app.inject({ method: "GET", url: "/read" });

    expect(response.json()).toEqual({ data: { feature: null } });
    expect(resolved).toEqual([]);
  });

  it("scopes a preview to its own request, so the next request does not inherit it", async () => {
    const app = await buildApp({ previews: { p1: viewOnly } });

    await app.inject({
      method: "GET",
      url: "/read",
      headers: { [PREVIEW_HEADER]: "p1" },
    });
    const next = await app.inject({ method: "GET", url: "/read" });

    expect(next.json()).toEqual({ data: { feature: null } });
    expect(next.headers["x-test-state-hash"]).toBe("plain");
  });

  it("refuses a write before its handler while a view-only preview applies", async () => {
    const writes: string[] = [];
    const app = await buildApp({ previews: { p1: viewOnly }, writes });

    const response = await app.inject({
      method: "POST",
      url: "/write",
      headers: { [PREVIEW_HEADER]: "p1" },
    });

    expect(response.statusCode).toBe(403);
    expect(errorBodyOf(response).code).toBe("FEATURE_PREVIEW_READ_ONLY");
    expect(writes).toEqual([]);
  });

  it("runs a route that manages the preview itself during a view-only preview", async () => {
    const writes: string[] = [];
    const app = await buildApp({ previews: { p1: viewOnly }, writes });

    const response = await app.inject({
      method: "POST",
      url: "/preview-control",
      headers: { [PREVIEW_HEADER]: "p1" },
    });

    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["preview-control"]);
  });

  it("runs writes under a preview that allows them, and with a dropped id", async () => {
    const writes: string[] = [];
    const app = await buildApp({
      previews: { p1: { ...viewOnly, allowsWrites: true } },
      writes,
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/write",
      headers: { [PREVIEW_HEADER]: "p1" },
    });
    const dropped = await app.inject({
      method: "POST",
      url: "/write",
      headers: { [PREVIEW_HEADER]: "gone" },
    });

    expect(allowed.statusCode).toBe(201);
    expect(dropped.statusCode).toBe(201);
    expect(writes).toEqual(["write", "write"]);
  });
});
