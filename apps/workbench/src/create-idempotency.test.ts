import { testAuthorizationFault } from "./testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
/** Caller keys replay durable creation attempts after failures without duplicating resources, activity, or relationships. */
import {
  executeWorkbenchRoute,
  operationOf,
} from "./testing/workbench-request.js";
import { describe, expect, it } from "vitest";
import {
  workbenchUser,
  workbenchWorkspace,
  type WorkbenchRelationship,
} from "./access.js";
import { createWorkbench } from "./create-workbench.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { createAuthorizationDouble } from "./testing/authorization-double.js";

const alice = { type: "user", id: "alice" };
const bob = { type: "user", id: "bob" };
const workspaceBody = {
  requestKey: "request-workspace-0001",
  name: "One workspace",
  description: "",
};

function setup() {
  const store = new MemoryWorkbenchStore();
  const backing = new WorkbenchMemoryAuthorization();
  let unavailable = false;
  let sequence = 0;
  let writes = 0;
  const authorization = createAuthorizationDouble(backing, {
    writeRelationships: (relationships: readonly WorkbenchRelationship[]) => {
      if (unavailable)
        return Promise.reject(
          testAuthorizationFault("UNAVAILABLE", "Unavailable"),
        );
      writes += 1;
      return backing.writeRelationships(relationships);
    },
  });
  const app = createWorkbench({
    store,
    authorization,
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => `idempotent-${String(++sequence)}`,
  });
  return {
    app,
    store,
    backing,
    writes: () => writes,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

describe("durable create idempotency", () => {
  it("replays a workspace after failed ownership synchronization instead of creating another", async () => {
    const { app, store, writes, setUnavailable } = setup();
    setUnavailable(true);
    await expect(
      app.operations.createWorkspace(alice, workspaceBody),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    const originalId = (await store.read()).workspaces[0]?.id;
    await expect(
      app.operations.createWorkspace(alice, workspaceBody),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    setUnavailable(false);
    const retry = await app.operations.createWorkspace(alice, workspaceBody);
    expect((await store.read()).workspaces).toHaveLength(1);
    expect(retry.id).toBe(originalId);
    expect((await store.read()).activity).toHaveLength(1);
    expect(writes()).toBe(1);
    expect(await app.operations.createWorkspace(alice, workspaceBody)).toEqual(
      retry,
    );
    expect(writes()).toBe(1);
  });

  it("replays task creation after failure, and artifact creation after a lost response", async () => {
    const { app, store, writes, setUnavailable } = setup();
    const workspace = await app.operations.createWorkspace(
      alice,
      workspaceBody,
    );
    const taskBody = {
      requestKey: "request-task-00001",
      title: "One task",
      description: "",
    };
    setUnavailable(true);
    await expect(
      app.operations.createTask(alice, workspace.id, taskBody),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    const originalTaskId = (await store.read()).tasks[0]?.id;
    setUnavailable(false);
    const task = await app.operations.createTask(alice, workspace.id, taskBody);
    expect(task.id).toBe(originalTaskId);
    expect((await store.read()).tasks).toHaveLength(1);
    const artifactBody = {
      requestKey: "request-artifact-0001",
      name: "proof.txt",
      content: "One artifact",
    };
    const artifact = await app.operations.createArtifact(
      alice,
      task.id,
      artifactBody,
    );
    expect(
      await app.operations.createArtifact(alice, task.id, artifactBody),
    ).toEqual(artifact);
    expect((await store.read()).artifacts).toHaveLength(1);
    expect((await store.read()).activity).toHaveLength(3);
    expect(writes()).toBe(2);
  });

  it("rejects changed payloads without deduplicating distinct request keys", async () => {
    const { app, store } = setup();
    const first = await app.operations.createWorkspace(alice, workspaceBody);
    await expect(
      app.operations.createWorkspace(alice, {
        ...workspaceBody,
        name: "Different",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await app.operations.createWorkspace(alice, {
      ...workspaceBody,
      requestKey: "request-workspace-0002",
    });
    expect(second.id).not.toBe(first.id);
    expect((await store.read()).workspaces).toHaveLength(2);
    const taskBody = {
      requestKey: "request-task-00001",
      title: "One task",
      description: "",
    };
    const task = await app.operations.createTask(alice, first.id, taskBody);
    await expect(
      app.operations.createTask(alice, first.id, {
        ...taskBody,
        title: "Different",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const artifactBody = {
      requestKey: "request-artifact-0001",
      name: "proof.txt",
      content: "One artifact",
    };
    await app.operations.createArtifact(alice, task.id, artifactBody);
    await expect(
      app.operations.createArtifact(alice, task.id, {
        ...artifactBody,
        content: "Different",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("scopes keys to the caller and parent and never resurrects a deleted resource", async () => {
    const { app, store } = setup();
    const first = await app.operations.createWorkspace(alice, workspaceBody);
    const otherCaller = await app.operations.createWorkspace(
      bob,
      workspaceBody,
    );
    expect(first.id).not.toBe(otherCaller.id);
    const second = await app.operations.createWorkspace(alice, {
      ...workspaceBody,
      requestKey: "request-workspace-0002",
    });
    const taskBody = {
      requestKey: "request-task-00001",
      title: "One task",
      description: "",
    };
    const firstTask = await app.operations.createTask(
      alice,
      first.id,
      taskBody,
    );
    const secondTask = await app.operations.createTask(
      alice,
      second.id,
      taskBody,
    );
    expect(firstTask.id).not.toBe(secondTask.id);
    await app.operations.deleteWorkspace(alice, first.id);
    await expect(
      app.operations.createWorkspace(alice, workspaceBody),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.read()).workspaces).toHaveLength(2);
  });

  it("requires bounded caller keys at the HTTP boundary", async () => {
    const { app, store } = setup();
    const route = app.routes
      .filter((entry) => entry.kind === "route")
      .find((entry) => operationOf(entry) === "createWorkspace");
    for (const body of [
      { name: "Missing key" },
      { name: "Short", requestKey: "short" },
      { name: "Long", requestKey: "x".repeat(129) },
      { name: "Invalid", requestKey: "invalid request key" },
    ]) {
      expect(
        await executeWorkbenchRoute(
          route,
          {
            params: {},
            query: {},
            body,
            subject: alice,
            requestId: "validation-test",
          },
          app,
        ),
      ).toMatchObject({ kind: "failure", status: 400 });
    }
    expect((await store.read()).workspaces).toEqual([]);
  });

  it("checks current authorization before replaying a previously successful creation", async () => {
    const { app, store, backing } = setup();
    const workspace = await app.operations.createWorkspace(
      alice,
      workspaceBody,
    );
    const taskBody = {
      requestKey: "request-task-00001",
      title: "One task",
      description: "",
    };
    const task = await app.operations.createTask(alice, workspace.id, taskBody);
    const artifactBody = {
      requestKey: "request-artifact-0001",
      name: "proof.txt",
      content: "Original",
    };
    await app.operations.createArtifact(alice, task.id, artifactBody);
    await backing.deleteExact({
      subject: { type: workbenchUser.wireName, id: alice.id },
      relation: workbenchWorkspace.roles.owner.roleName,
      resource: { type: workbenchWorkspace.entity.wireName, id: workspace.id },
    });
    await expect(
      app.operations.createWorkspace(alice, workspaceBody),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      app.operations.createTask(alice, workspace.id, taskBody),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      app.operations.createArtifact(alice, task.id, artifactBody),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await store.read()).workspaces).toHaveLength(1);
    expect((await store.read()).tasks).toHaveLength(1);
    expect((await store.read()).artifacts).toHaveLength(1);
    expect((await store.read()).activity).toHaveLength(3);
  });

  it("caps retained requests at 10000 without evicting keys or blocking existing replays", async () => {
    const { app, store } = setup();
    const workspace = await app.operations.createWorkspace(
      alice,
      workspaceBody,
    );
    await store.transaction((state) => {
      for (let index = 1; index < 10_000; index += 1) {
        state.createRequests.push({
          subjectType: "user",
          subjectId: "alice",
          operation: "createWorkspace",
          parentId: null,
          requestKey: `historical-request-${String(index)}`,
          payload: ["Deleted historical resource", ""],
          resourceId: `historical-${String(index)}`,
        });
      }
    });
    await expect(
      app.operations.createWorkspace(alice, {
        ...workspaceBody,
        requestKey: "new-distinct-request-0001",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await app.operations.createWorkspace(alice, workspaceBody)).toEqual(
      workspace,
    );
    expect((await store.read()).workspaces).toHaveLength(1);
    await app.operations.deleteWorkspace(alice, workspace.id);
    expect((await store.read()).createRequests).toHaveLength(10_000);
    await expect(
      app.operations.createWorkspace(alice, workspaceBody),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.read()).workspaces).toEqual([]);
  });

  it("compares normalized contract payloads and serializes simultaneous retries", async () => {
    const { app, store, writes } = setup();
    const route = app.routes
      .filter((entry) => entry.kind === "route")
      .find((entry) => operationOf(entry) === "createWorkspace");
    const request = {
      params: {},
      query: {},
      subject: alice,
      requestId: "normalized-request",
    };
    const first = await executeWorkbenchRoute(
      route,
      {
        ...request,
        body: { requestKey: workspaceBody.requestKey, name: " One workspace " },
      },
      app,
    );
    const retry = await executeWorkbenchRoute(
      route,
      { ...request, body: workspaceBody },
      app,
    );
    expect(first.kind).toBe("success");
    expect(retry).toEqual(first);
    const bodies = { ...workspaceBody, requestKey: "concurrent-request-0001" };
    const [one, two] = await Promise.all([
      app.operations.createWorkspace(alice, bodies),
      app.operations.createWorkspace(alice, bodies),
    ]);
    expect(one).toEqual(two);
    expect((await store.read()).workspaces).toHaveLength(2);
    expect((await store.read()).activity).toHaveLength(2);
    expect(writes()).toBe(2);
  });
});
