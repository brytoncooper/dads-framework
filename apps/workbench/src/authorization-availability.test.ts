import { testAuthorizationFault } from "./testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
/** Known authorization outages produce a typed denial; programming failures remain errors for the server boundary. */
import {
  executeWorkbenchRoute,
  operationOf,
} from "./testing/workbench-request.js";
import { describe, expect, it } from "vitest";
import { createWorkbench } from "./create-workbench.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { createAuthorizationDouble } from "./testing/authorization-double.js";

const outageCodes: readonly string[] = ["UNAVAILABLE", "LIMIT_EXCEEDED"];

function createUnavailableApp(code: string) {
  const backing = new WorkbenchMemoryAuthorization();
  const authorization = createAuthorizationDouble(backing, {
    check: () =>
      Promise.reject(
        testAuthorizationFault(code, "Private adapter diagnostic"),
      ),
  });
  return createWorkbench({
    store: new MemoryWorkbenchStore(),
    authorization,
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => "unavailable-resource",
  });
}

function readWorkspace(app: ReturnType<typeof createWorkbench>) {
  return executeWorkbenchRoute(
    app.routes
      .filter((route) => route.kind === "route")
      .find((route) => operationOf(route) === "getWorkspace"),
    {
      params: { workspaceId: "workspace-1" },
      query: {},
      body: undefined,
      subject: { type: "user", id: "alice" },
      requestId: "unavailable-request",
    },
    app,
  );
}

describe("workbench authorization availability", () => {
  it.each(outageCodes)("maps %s to a safe typed 503", async (code) => {
    const outcome = await readWorkspace(createUnavailableApp(code));
    expect(outcome).toMatchObject({
      kind: "failure",
      status: 503,
      error: { code: "AUTHORIZATION_UNAVAILABLE" },
    });
    expect(JSON.stringify(outcome)).not.toContain("Private adapter diagnostic");
  });

  it("does not relabel an invalid model as an outage", async () => {
    expect(
      await readWorkspace(createUnavailableApp("INVALID_MODEL")),
    ).toMatchObject({ status: 500 });
  });

  it.each([
    testAuthorizationFault("INVALID_MODEL", "Invalid write model"),
    new TypeError("Unexpected adapter bug"),
  ])(
    "retains pending work without relabeling an unexpected write failure: %s",
    async (error) => {
      const store = new MemoryWorkbenchStore();
      const backing = new WorkbenchMemoryAuthorization();
      let sequence = 0;
      const app = createWorkbench({
        store,
        authorization: createAuthorizationDouble(backing, {
          writeRelationships: () => Promise.reject(error),
        }),
        clock: () => "2026-08-31T12:00:00.000Z",
        createId: () => `unexpected-${String(++sequence)}`,
      });
      await expect(
        app.operations.createWorkspace(
          { type: "user", id: "alice" },
          {
            requestKey: "unexpected-write-request",
            name: "Pending diagnostic",
            description: "",
          },
        ),
      ).rejects.toBe(error);
      expect((await store.read()).pendingAuthorizationChanges).toHaveLength(1);
      expect((await store.read()).createRequests).toHaveLength(1);
      expect(await readWorkspace(app)).toMatchObject({ status: 500 });
    },
  );
});
