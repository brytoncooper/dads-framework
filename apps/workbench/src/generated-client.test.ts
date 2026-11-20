// The example consumes its generated SDK over real HTTP, proving route contracts
// stay useful for CRUD, authorization discovery and immediate revocation.
import { describe, expect, it } from "vitest";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
import { createClient } from "./client.generated.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { startWorkbenchServer } from "./server.js";

describe("workbench generated SDK", () => {
  it("runs CRUD and permission changes using caller inputs and parsed outputs", async () => {
    const running = await startWorkbenchServer({
      store: new MemoryWorkbenchStore(),
      authorization: new WorkbenchMemoryAuthorization(),
      port: 0,
    });
    const alice = createClient({
      baseUrl: running.url,
      headers: { "x-workbench-user": "alice" },
    });
    const bob = createClient({
      baseUrl: running.url,
      headers: { "x-workbench-user": "bob" },
    });
    try {
      const workspace = await alice.createWorkspace({
        body: { requestKey: "sdk-workspace-key-01", name: "SDK workspace" },
      });
      expect(workspace.description).toBe("");
      expect(await bob.listWorkspaces({ query: {} })).toEqual([]);
      const workspaceParams = { workspaceId: workspace.id };
      await alice.updateWorkspace({
        params: workspaceParams,
        body: { name: "Updated workspace" },
      });
      expect(
        await alice.getWorkspace({ params: workspaceParams }),
      ).toMatchObject({ name: "Updated workspace" });
      const task = await alice.createTask({
        params: workspaceParams,
        body: { requestKey: "sdk-task-key-0001", title: "Verify the API" },
      });
      const taskParams = { taskId: task.id };
      await expect(bob.getTask({ params: taskParams })).rejects.toMatchObject({
        status: 404,
      });
      await alice.grantMember({
        params: workspaceParams,
        body: { userId: "bob" },
      });
      expect(
        await alice.listMembers({ params: workspaceParams, query: {} }),
      ).toHaveLength(2);
      expect(
        await bob.listTasks({ params: workspaceParams, query: { page: "1" } }),
      ).toHaveLength(1);
      expect(
        await bob.claimTask({ params: taskParams, body: {} }),
      ).toMatchObject({ claimedBy: "bob" });
      await expect(
        bob.updateTask({ params: taskParams, body: { title: "Not allowed" } }),
      ).rejects.toMatchObject({ status: 404 });
      await alice.createArtifact({
        params: taskParams,
        body: {
          requestKey: "sdk-artifact-key-01",
          name: "Proof",
          content: "Actual HTTP",
        },
      });
      expect(
        await bob.listArtifacts({ params: taskParams, query: {} }),
      ).toHaveLength(1);
      expect(
        (await alice.listActivity({ params: workspaceParams, query: {} }))
          .length,
      ).toBeGreaterThan(0);
      await alice.revokeMember({
        params: { ...workspaceParams, userId: "bob" },
      });
      expect(
        await bob.listTasks({ params: workspaceParams, query: {} }),
      ).toEqual([]);
      await expect(bob.getTask({ params: taskParams })).rejects.toMatchObject({
        status: 404,
      });
      expect(await bob.listWorkspaces({ query: {} })).toEqual([]);
      expect(
        await bob.listArtifacts({ params: taskParams, query: {} }),
      ).toEqual([]);
      expect(
        await bob.listActivity({ params: workspaceParams, query: {} }),
      ).toEqual([]);
      await expect(
        bob.claimTask({ params: taskParams, body: {} }),
      ).rejects.toMatchObject({ status: 404 });
      await alice.updateTask({ params: taskParams, body: { status: "done" } });
      await alice.deleteTask({ params: taskParams });
      expect(
        await alice.listTasks({ params: workspaceParams, query: {} }),
      ).toEqual([]);
      await alice.deleteWorkspace({ params: workspaceParams });
      expect(await alice.listWorkspaces({ query: {} })).toEqual([]);
    } finally {
      await running.stop();
    }
  });
});
