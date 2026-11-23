import { z } from "zod";
import { operationOf } from "./testing/workbench-request.js";
import { testAuthorizationFault } from "./testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
/** Real HTTP must distinguish an outage during the handler's fresh access check from a denial or programming error. */
import { afterEach, describe, expect, it } from "vitest";
import { createWorkbench } from "./create-workbench.js";
import { startWorkbenchServer } from "./server.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { createAuthorizationDouble } from "./testing/authorization-double.js";

const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((stop) => stop()));
});

async function startWithSecondFailure(method: "check" | "lookup", error: Error) {
  const store = new MemoryWorkbenchStore();
  const backing = new WorkbenchMemoryAuthorization();
  let sequence = 0;
  const seed = createWorkbench({
    store,
    authorization: backing,
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => `handler-proof-${String(++sequence)}`,
  });
  const workspace = await seed.operations.createWorkspace(
    { type: "user", id: "alice" },
    {
      requestKey: "handler-proof-request",
      name: "Private workspace",
      description: "",
    },
  );
  let checks = 0;
  let lookups = 0;
  const authorization = createAuthorizationDouble(backing, {
    check: async (query) => {
      checks += 1;
      if (method === "check" && checks === 2) throw error;
      return backing.check(query);
    },
    lookupResources: async (query) => {
      lookups += 1;
      if (method === "lookup" && lookups === 2) throw error;
      return backing.lookupResources(query);
    },
  });
  const running = await startWorkbenchServer({ store, authorization, port: 0 });
  shutdowns.push(running.stop);
  return {
    createUrl: `${running.url}/api/workspaces`,
    specUrl: `${running.url}/api/openapi.json`,
    url: `${running.url}/api/workspaces${method === "check" ? `/${workspace.id}` : ""}`,
    attempts: () => (method === "check" ? checks : lookups),
    routes: seed.routes,
  };
}

const cases: readonly {
  method: "check" | "lookup";
  error: Error;
  status: number;
  code: string;
}[] = [
  {
    method: "check",
    error: testAuthorizationFault("UNAVAILABLE", "Private adapter diagnostic"),
    status: 503,
    code: "AUTHORIZATION_UNAVAILABLE",
  },
  {
    method: "check",
    error: testAuthorizationFault("LIMIT_EXCEEDED", "Private adapter diagnostic"),
    status: 503,
    code: "AUTHORIZATION_UNAVAILABLE",
  },
  {
    method: "lookup",
    error: testAuthorizationFault("UNAVAILABLE", "Private adapter diagnostic"),
    status: 503,
    code: "AUTHORIZATION_UNAVAILABLE",
  },
  {
    method: "lookup",
    error: testAuthorizationFault("LIMIT_EXCEEDED", "Private adapter diagnostic"),
    status: 503,
    code: "AUTHORIZATION_UNAVAILABLE",
  },
  {
    method: "check",
    error: testAuthorizationFault("INVALID_MODEL", "Private adapter diagnostic"),
    status: 500,
    code: "INTERNAL_ERROR",
  },
  {
    method: "lookup",
    error: testAuthorizationFault("INVALID_MODEL", "Private adapter diagnostic"),
    status: 500,
    code: "INTERNAL_ERROR",
  },
  {
    method: "check",
    error: new TypeError("Private adapter diagnostic"),
    status: 500,
    code: "INTERNAL_ERROR",
  },
  {
    method: "lookup",
    error: new TypeError("Private adapter diagnostic"),
    status: 500,
    code: "INTERNAL_ERROR",
  },
];

describe("handler authorization availability", () => {
  it.each(cases)(
    "returns $status when the second $method fails with $error",
    async ({ method, error, status, code }) => {
      const running = await startWithSecondFailure(method, error);
      const response = await fetch(running.url, {
        headers: { "x-workbench-user": "alice" },
      });
      const body: unknown = await response.json();
      expect(running.attempts()).toBe(2);
      expect(response.status).toBe(status);
      expect(body).toMatchObject({ error: { code } });
      expect(JSON.stringify(body)).not.toContain("Private adapter diagnostic");
      expect(JSON.stringify(body)).not.toContain("Private workspace");
    },
  );

  it.each([
    testAuthorizationFault("UNAVAILABLE", "Private replay diagnostic"),
    testAuthorizationFault("LIMIT_EXCEEDED", "Private replay diagnostic"),
  ])("returns 503 when a creation replay cannot recheck access: %s", async (error) => {
    const running = await startWithSecondFailure("check", error);
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workbench-user": "alice",
      },
      body: JSON.stringify({
        requestKey: "handler-proof-request",
        name: "Private workspace",
      }),
    };
    const firstReplay = await fetch(running.createUrl, request);
    expect(firstReplay.status).toBe(201);
    await firstReplay.json();
    const unavailableReplay = await fetch(running.createUrl, request);
    const body: unknown = await unavailableReplay.json();
    expect(running.attempts()).toBe(2);
    expect(unavailableReplay.status).toBe(503);
    expect(body).toMatchObject({
      error: { code: "AUTHORIZATION_UNAVAILABLE" },
    });
    expect(JSON.stringify(body)).not.toContain("Private replay diagnostic");
    expect(JSON.stringify(body)).not.toContain("Private workspace");
  });

  it("keeps missing-relationship denial at 404 without running a handler recheck", async () => {
    const running = await startWithSecondFailure(
      "check",
      testAuthorizationFault("UNAVAILABLE", "Should not be reached"),
    );
    const response = await fetch(running.url, {
      headers: { "x-workbench-user": "outsider" },
    });
    expect(response.status).toBe(404);
    expect(running.attempts()).toBe(1);
  });

  it("declares the expected authorization-unavailable error on every workbench route", async () => {
    const running = await startWithSecondFailure("check", new Error("Unused"));
    expect(running.routes).toHaveLength(18);
    const response = await fetch(running.specUrl);
    expect(response.status).toBe(200);
    const schema = z.object({
      paths: z.record(
        z.string(),
        z.record(
          z.string(),
          z.object({
            responses: z.record(z.string(), z.unknown()),
          }),
        ),
      ),
    });
    const document = schema.parse(await response.json());
    for (const route of running.routes) {
      const path = route.path.replace(/:(\w+)/g, "{$1}");
      const unavailable = document.paths[path]?.[route.method.toLowerCase()]?.responses["503"];
      const responseSchema = z.object({
        content: z.object({
          "application/json": z.object({
            schema: z.object({
              properties: z.object({
                error: z.object({
                  properties: z.object({
                    code: z.object({ enum: z.array(z.string()) }),
                  }),
                }),
              }),
            }),
          }),
        }),
      });
      const responseCodes =
        responseSchema.parse(unavailable).content["application/json"].schema.properties.error.properties.code.enum;
      expect(responseCodes, operationOf(route)).toContain("AUTHORIZATION_UNAVAILABLE");
    }
  });
});
