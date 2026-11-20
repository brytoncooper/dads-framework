import { testAuthorizationFault } from "./testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
/** Large deletions must respect atomic adapter batch limits and resume a partially applied durable cleanup. */
import { describe, expect, it } from "vitest";
import {
  workbenchTask,
  workbenchUser,
  workbenchWorkspace,
  type WorkbenchRelationship,
} from "./access.js";
import { createWorkbench } from "./create-workbench.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { createAuthorizationDouble } from "./testing/authorization-double.js";

describe("bounded relationship cleanup", () => {
  it("resumes more than 1000 relationships without sending an oversized atomic batch", async () => {
    const store = new MemoryWorkbenchStore();
    const backing = new WorkbenchMemoryAuthorization();
    const attemptedBatchSizes: number[] = [];
    let unavailable = true;
    let sequence = 0;
    const authorization = createAuthorizationDouble(backing, {
      deleteRelationships: (filter) => {
        attemptedBatchSizes.push(1);
        if (unavailable && attemptedBatchSizes.length > 500) {
          return Promise.reject(
            testAuthorizationFault(
              "UNAVAILABLE",
              "Cleanup backend temporarily unavailable",
            ),
          );
        }
        return backing.deleteRelationships(filter);
      },
    });
    const app = createWorkbench({
      store,
      authorization,
      clock: () => "2026-08-31T12:00:00.000Z",
      createId: () => `cleanup-${String(++sequence)}`,
    });
    const subject = { type: "user", id: "alice" };
    const workspace = await app.operations.createWorkspace(subject, {
      requestKey: "test-create-request-00023",
      name: "Large workspace",
      description: "",
    });
    const taskRelationships: WorkbenchRelationship[] = [];
    await store.transaction((state) => {
      for (let index = 0; index < 1001; index += 1) {
        const id = `task-${String(index)}`;
        state.tasks.push({
          id,
          workspaceId: workspace.id,
          title: "Cleanup task",
          description: "",
          status: "todo",
          claimedBy: null,
          createdAt: workspace.createdAt,
          updatedAt: workspace.createdAt,
        });
        taskRelationships.push({
          subject: {
            type: workbenchWorkspace.entity.wireName,
            id: workspace.id,
          },
          relation: workbenchTask.roles.workspace.roleName,
          resource: { type: workbenchTask.entity.wireName, id },
        });
      }
    });
    await backing.writeRelationships(taskRelationships);

    await expect(
      app.operations.deleteWorkspace(subject, workspace.id),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    expect(attemptedBatchSizes).toHaveLength(501);
    expect((await store.read()).workspaces).toEqual([]);
    expect((await store.read()).tasks).toEqual([]);
    expect(
      (await store.read()).pendingAuthorizationChanges.map(
        (entry) => entry.deletes.length,
      ),
    ).toEqual([1002]);
    await expect(
      app.operations.getWorkspace(subject, workspace.id),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });

    unavailable = false;
    await app.operations.synchronize();
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
    expect(attemptedBatchSizes.every((size) => size <= 500)).toBe(true);
    expect(
      await backing.lookupResources({
        subject: { type: workbenchUser.wireName, id: subject.id },
        permission: workbenchTask.permissions.view.permissionName,
        resourceType: workbenchTask.entity.wireName,
      }),
    ).toEqual([]);
    for (const relationship of taskRelationships)
      expect(await backing.hasTuple(relationship)).toBe(false);
  });
});
