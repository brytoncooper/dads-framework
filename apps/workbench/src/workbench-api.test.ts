import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
/** Exercises the public HTTP boundary: owned creation, filtered discovery, CRUD, and revocation after a claim. */
import {
  executeWorkbenchRoute,
  operationOf,
  type Operation,
} from "./testing/workbench-request.js";
import { describe, expect, it } from "vitest";
import { workbenchUser, workbenchWorkspace } from "./access.js";
import { taskResponse, workspaceResponse } from "./contracts.js";
import { createWorkbench } from "./create-workbench.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";

export function setupWorkbench() {
  let sequence = 0;
  const store = new MemoryWorkbenchStore();
  const authorization = new WorkbenchMemoryAuthorization();
  const app = createWorkbench({
    store,
    authorization,
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => `resource-${String(++sequence)}`,
  });
  return { app, store, authorization };
}

export async function call(
  app: ReturnType<typeof createWorkbench>,
  operation: Operation,
  userId: string,
  params: unknown = {},
  body?: unknown,
  query: unknown = {},
) {
  return executeWorkbenchRoute(
    app.routes
      .filter((route) => route.kind === "route")
      .find((route) => operationOf(route) === operation),
    {
      params,
      body,
      query,
      subject: { type: "user", id: userId },
      requestId: "test-request",
    },
    app,
  );
}

export function successfulData(outcome: Awaited<ReturnType<typeof call>>) {
  expect(outcome.kind).toBe("success");
  if (outcome.kind !== "success") throw new Error("Expected HTTP success");
  return outcome.data;
}

describe("workbench API", () => {
  it("exposes the actual workspace, task, membership, artifact, and activity API", () => {
    const { app } = setupWorkbench();
    expect(app.routes.map(operationOf).sort()).toEqual(
      [
        "claimTask",
        "createArtifact",
        "createTask",
        "createWorkspace",
        "deleteTask",
        "deleteWorkspace",
        "getTask",
        "getWorkspace",
        "grantMember",
        "listActivity",
        "listArtifacts",
        "listMembers",
        "listTasks",
        "listWorkspaces",
        "streamActivity",
        "revokeMember",
        "updateTask",
        "updateWorkspace",
      ].sort(),
    );
    expect(app.routes.every((route) => route.path.startsWith("/api/"))).toBe(
      true,
    );
  });

  it("creates durable ownership and filters workspace discovery with no fallback", async () => {
    const { app, authorization } = setupWorkbench();
    const workspace = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "alice",
          {},
          { requestKey: "test-create-request-00001", name: "API work" },
        ),
      ),
    );
    expect(
      await authorization.hasTuple({
        subject: { type: workbenchUser.wireName, id: "alice" },
        relation: workbenchWorkspace.roles.owner.roleName,
        resource: {
          type: workbenchWorkspace.wireName,
          id: workspace.id,
        },
      }),
    ).toBe(true);
    expect(successfulData(await call(app, "listWorkspaces", "alice"))).toEqual([
      workspace,
    ]);
    expect(
      successfulData(await call(app, "listWorkspaces", "outsider")),
    ).toEqual([]);
    expect(
      await call(app, "getWorkspace", "outsider", {
        workspaceId: workspace.id,
      }),
    ).toMatchObject({ kind: "failure", status: 404 });
    expect(
      await call(
        app,
        "updateWorkspace",
        "outsider",
        { workspaceId: workspace.id },
        { name: "Denied" },
      ),
    ).toMatchObject({ kind: "failure", status: 404 });
  });

  it("revokes inherited task reads, writes, claims, artifacts, and activity after membership removal", async () => {
    const { app } = setupWorkbench();
    const workspace = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "alice",
          {},
          { requestKey: "test-create-request-00002", name: "Owned" },
        ),
      ),
    );
    const wp = { workspaceId: workspace.id };
    await call(app, "grantMember", "alice", wp, { userId: "bob" });
    const task = taskResponse.parse(
      successfulData(
        await call(app, "createTask", "alice", wp, {
          requestKey: "test-create-request-00003",
          title: "Claim safely",
        }),
      ),
    );
    const tp = { taskId: task.id };
    expect(
      successfulData(await call(app, "claimTask", "bob", tp, {})),
    ).toMatchObject({ claimedBy: "bob" });
    expect(
      successfulData(await call(app, "listTasks", "bob", wp)),
    ).toHaveLength(1);
    expect(
      await call(app, "revokeMember", "alice", { ...wp, userId: "bob" }),
    ).toMatchObject({ kind: "success", status: 204 });
    for (const operation of [
      "getTask",
      "updateTask",
      "deleteTask",
      "claimTask",
    ] as const) {
      expect(
        await call(
          app,
          operation,
          "bob",
          tp,
          operation === "updateTask" ? { title: "Denied" } : {},
        ),
      ).toMatchObject({ kind: "failure", status: 404 });
    }
    expect(successfulData(await call(app, "listTasks", "bob", wp))).toEqual([]);
    expect(successfulData(await call(app, "listArtifacts", "bob", tp))).toEqual(
      [],
    );
    expect(successfulData(await call(app, "listActivity", "bob", wp))).toEqual(
      [],
    );
  });

  it("runs workspace and task CRUD and bounds text artifacts", async () => {
    const { app, store } = setupWorkbench();
    const workspace = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "alice",
          {},
          { requestKey: "test-create-request-00004", name: "Before" },
        ),
      ),
    );
    const wp = { workspaceId: workspace.id };
    expect(
      successfulData(
        await call(app, "updateWorkspace", "alice", wp, { name: "After" }),
      ),
    ).toMatchObject({ name: "After" });
    const task = taskResponse.parse(
      successfulData(
        await call(app, "createTask", "alice", wp, {
          requestKey: "test-create-request-00005",
          title: "Before",
        }),
      ),
    );
    const tp = { taskId: task.id };
    expect(
      successfulData(
        await call(app, "updateTask", "alice", tp, {
          title: "After",
          status: "done",
        }),
      ),
    ).toMatchObject({ title: "After", status: "done" });
    expect(
      successfulData(await call(app, "getTask", "alice", tp)),
    ).toMatchObject({ title: "After" });
    expect(
      successfulData(
        await call(app, "createArtifact", "alice", tp, {
          requestKey: "test-create-request-00006",
          name: "proof.txt",
          content: "Bounded evidence",
        }),
      ),
    ).toMatchObject({ content: "Bounded evidence" });
    expect(
      successfulData(await call(app, "listArtifacts", "alice", tp)),
    ).toHaveLength(1);
    expect(
      await call(app, "createArtifact", "alice", tp, {
        requestKey: "test-create-request-00007",
        name: "large.txt",
        content: "x".repeat(8_193),
      }),
    ).toMatchObject({ kind: "failure", status: 400 });
    expect(
      successfulData(await call(app, "listActivity", "alice", wp)),
    ).toHaveLength(5);
    expect(await call(app, "deleteTask", "alice", tp)).toMatchObject({
      kind: "success",
      status: 204,
    });
    expect(await call(app, "getTask", "alice", tp)).toMatchObject({
      kind: "failure",
      status: 404,
    });
    expect(await call(app, "deleteWorkspace", "alice", wp)).toMatchObject({
      kind: "success",
      status: 204,
    });
    expect((await store.read()).workspaces).toEqual([]);
    expect((await store.read()).artifacts).toEqual([]);
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
  });

  it("requires authentication and keeps workspace administration owner-only", async () => {
    const { app } = setupWorkbench();
    const createRoute = app.routes
      .filter((route) => route.kind === "route")
      .find((route) => operationOf(route) === "createWorkspace");
    expect(
      await executeWorkbenchRoute(
        createRoute,
        {
          params: {},
          query: {},
          body: { requestKey: "test-create-request-00008", name: "Anonymous" },
          subject: null,
          requestId: "anonymous",
        },
        app,
      ),
    ).toMatchObject({ kind: "failure", status: 401 });
    const workspace = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "alice",
          {},
          { requestKey: "test-create-request-00009", name: "Owner only" },
        ),
      ),
    );
    const wp = { workspaceId: workspace.id };
    successfulData(
      await call(app, "grantMember", "alice", wp, { userId: "bob" }),
    );
    expect(
      successfulData(await call(app, "listMembers", "alice", wp)),
    ).toHaveLength(2);
    expect(successfulData(await call(app, "listMembers", "bob", wp))).toEqual(
      [],
    );
    expect(
      await call(app, "grantMember", "bob", wp, { userId: "outsider" }),
    ).toMatchObject({ kind: "failure", status: 404 });
    expect(
      await call(app, "revokeMember", "bob", { ...wp, userId: "alice" }),
    ).toMatchObject({ kind: "failure", status: 404 });
    expect(
      await call(app, "revokeMember", "alice", { ...wp, userId: "alice" }),
    ).toMatchObject({ kind: "failure", status: 409 });
    expect(
      await call(app, "createTask", "outsider", wp, {
        requestKey: "test-create-request-00010",
        title: "Denied",
      }),
    ).toMatchObject({ kind: "failure", status: 404 });
    expect(await call(app, "deleteWorkspace", "outsider", wp)).toMatchObject({
      kind: "failure",
      status: 404,
    });
  });

  it("keeps collection results workspace-scoped and accepts real URL pagination", async () => {
    const { app } = setupWorkbench();
    const first = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "alice",
          {},
          { requestKey: "test-create-request-00011", name: "First" },
        ),
      ),
    );
    const second = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "bob",
          {},
          { requestKey: "test-create-request-00012", name: "Second" },
        ),
      ),
    );
    await call(
      app,
      "createTask",
      "alice",
      { workspaceId: first.id },
      { requestKey: "test-create-request-00013", title: "First task" },
    );
    await call(
      app,
      "createTask",
      "bob",
      { workspaceId: second.id },
      { requestKey: "test-create-request-00014", title: "Second task" },
    );
    expect(
      successfulData(
        await call(app, "listTasks", "alice", { workspaceId: second.id }),
      ),
    ).toEqual([]);
    expect(
      successfulData(
        await call(app, "listActivity", "alice", { workspaceId: second.id }),
      ),
    ).toEqual([]);
    expect(
      await call(
        app,
        "listTasks",
        "alice",
        { workspaceId: first.id },
        undefined,
        { page: "1", perPage: "1" },
      ),
    ).toMatchObject({
      kind: "success",
      meta: { page: 1, perPage: 1, total: 1, pageCount: 1 },
    });
    expect(
      await call(
        app,
        "updateWorkspace",
        "alice",
        { workspaceId: first.id },
        {},
      ),
    ).toMatchObject({ kind: "failure", status: 400 });
    expect(
      await call(
        app,
        "createWorkspace",
        "alice",
        {},
        {
          requestKey: "test-create-request-00015",
          name: "Unknown field",
          administrator: true,
        },
      ),
    ).toMatchObject({ kind: "failure", status: 400 });
  });

  it("rejects invalid relationship identifiers before they can poison the durable queue", async () => {
    const { app, store } = setupWorkbench();
    const workspace = workspaceResponse.parse(
      successfulData(
        await call(
          app,
          "createWorkspace",
          "alice",
          {},
          { requestKey: "test-create-request-00016", name: "Valid IDs" },
        ),
      ),
    );
    expect(
      await call(
        app,
        "grantMember",
        "alice",
        { workspaceId: workspace.id },
        { userId: "\ud800" },
      ),
    ).toMatchObject({ kind: "failure", status: 400 });
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
  });
});
