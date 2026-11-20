// What/why: lock the reviewed liveness/readiness route cards and behavior.
import { afterEach, describe, expect, it } from "vitest";

import {
  buildTestApp,
  dataBodyOf,
  errorBodyOf,
  type TestApp,
} from "../../testing/index.js";

import { createHealthRoutes } from "../index.js";
import { healthStatusSchema, readyStatusSchema } from "./health.schemas.js";

describe("createHealthRoutes", () => {
  const apps: TestApp[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  async function boot(
    pingDatabase: () => Promise<void>,
    pingCriticalServices: () => Promise<void> = () => Promise.resolve(),
  ) {
    const app = await buildTestApp({
      routes: createHealthRoutes({ pingDatabase, pingCriticalServices }),
    });
    apps.push(app);
    return app;
  }

  it("declares both probes as public literal route cards", () => {
    const routes = createHealthRoutes({
      pingDatabase: () => Promise.resolve(),
      pingCriticalServices: () => Promise.resolve(),
    }).filter((route) => route.kind === "route");

    expect(
      routes.map(({ method, path, tag, access, descriptor }) => ({
        method,
        path,
        tag,
        access: access.kind,
        descriptor,
      })),
    ).toEqual([
      {
        method: "GET",
        path: "/health",
        tag: "Health",
        access: "public",
        descriptor: { method: "GET", template: "/health" },
      },
      {
        method: "GET",
        path: "/ready",
        tag: "Health",
        access: "public",
        descriptor: { method: "GET", template: "/ready" },
      },
    ]);
  });

  it("answers liveness without pinging anything", async () => {
    const app = await boot(
      () => Promise.reject(new Error("database must not be touched")),
      () => Promise.reject(new Error("services must not be touched")),
    );
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(dataBodyOf(response, healthStatusSchema)).toEqual({ status: "ok" });
  });

  it("answers ready when every ping resolves", async () => {
    const app = await boot(() => Promise.resolve());
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(dataBodyOf(response, readyStatusSchema)).toEqual({
      status: "ready",
    });
  });

  it("returns 503 NOT_READY when the database ping fails", async () => {
    const app = await boot(() => Promise.reject(new Error("down")));
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(errorBodyOf(response).code).toBe("NOT_READY");
  });

  it("returns 503 NOT_READY when a critical service ping fails", async () => {
    const app = await boot(
      () => Promise.resolve(),
      () => Promise.reject(new Error("down")),
    );
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(errorBodyOf(response).code).toBe("NOT_READY");
  });

  it("does not register GET /", async () => {
    const app = await boot(() => Promise.resolve());
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(404);
    expect(errorBodyOf(response).code).toBe("NOT_FOUND");
  });
});
