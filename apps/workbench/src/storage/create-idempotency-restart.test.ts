import { testAuthorizationFault } from "../testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "../testing/workbench-memory-authorization.js";
/** The creation key and resource must survive SQLite restart together, including a pending ownership write. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workbenchUser, workbenchWorkspace } from "../access.js";
import { createWorkbench } from "../create-workbench.js";
import { createAuthorizationDouble } from "../testing/authorization-double.js";
import { SqliteWorkbenchStore } from "./sqlite-workbench-store.js";

it("replays the same creation key after failed authorization and SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dads-create-retry-"));
  const path = join(directory, "workbench.sqlite");
  const authorization = new WorkbenchMemoryAuthorization();
  const unavailable = createAuthorizationDouble(authorization, {
    writeRelationships: () =>
      Promise.reject(testAuthorizationFault("UNAVAILABLE", "Unavailable")),
  });
  let sequence = 0;
  const dependencies = {
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => `restart-retry-${String(++sequence)}`,
  };
  const body = {
    requestKey: "persisted-create-request-0001",
    name: "Persisted attempt",
    description: "",
  };
  const subject = { type: "user", id: "alice" };
  let originalId: string | undefined;
  try {
    const firstStore = new SqliteWorkbenchStore(path);
    try {
      const first = createWorkbench({
        ...dependencies,
        store: firstStore,
        authorization: unavailable,
      });
      await expect(
        first.operations.createWorkspace(subject, body),
      ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
      originalId = (await firstStore.read()).workspaces[0]?.id;
    } finally {
      firstStore.close();
    }
    const reopened = new SqliteWorkbenchStore(path);
    try {
      const second = createWorkbench({
        ...dependencies,
        store: reopened,
        authorization,
      });
      const retry = await second.operations.createWorkspace(subject, body);
      expect((await reopened.read()).workspaces).toHaveLength(1);
      expect(retry.id).toBe(originalId);
      expect((await reopened.read()).activity).toHaveLength(1);
      expect((await reopened.read()).pendingAuthorizationChanges).toEqual([]);
      expect(
        await authorization.listDirectSubjects({
          resource: { type: workbenchWorkspace.wireName, id: retry.id },
          relation: workbenchWorkspace.roles.owner.roleName,
        }),
      ).toEqual([{ type: workbenchUser.wireName, id: subject.id }]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains task and artifact request keys across SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dads-child-create-retry-"));
  const path = join(directory, "workbench.sqlite");
  const authorization = new WorkbenchMemoryAuthorization();
  let sequence = 0;
  const dependencies = {
    authorization,
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => `persisted-child-${String(++sequence)}`,
  };
  const subject = { type: "user", id: "alice" };
  const workspaceBody = {
    requestKey: "persisted-workspace-request",
    name: "Workspace",
    description: "",
  };
  const taskBody = {
    requestKey: "persisted-task-request",
    title: "Task",
    description: "",
  };
  const artifactBody = {
    requestKey: "persisted-artifact-request",
    name: "Proof",
    content: "Original",
  };
  try {
    const firstStore = new SqliteWorkbenchStore(path);
    const original = await (async () => {
      try {
        const first = createWorkbench({ ...dependencies, store: firstStore });
        const workspace = await first.operations.createWorkspace(
          subject,
          workspaceBody,
        );
        const task = await first.operations.createTask(
          subject,
          workspace.id,
          taskBody,
        );
        const artifact = await first.operations.createArtifact(
          subject,
          task.id,
          artifactBody,
        );
        return { workspace, task, artifact };
      } finally {
        firstStore.close();
      }
    })();
    const reopened = new SqliteWorkbenchStore(path);
    try {
      const second = createWorkbench({ ...dependencies, store: reopened });
      expect(
        await second.operations.createTask(
          subject,
          original.workspace.id,
          taskBody,
        ),
      ).toEqual(original.task);
      expect(
        await second.operations.createArtifact(
          subject,
          original.task.id,
          artifactBody,
        ),
      ).toEqual(original.artifact);
      expect((await reopened.read()).tasks).toHaveLength(1);
      expect((await reopened.read()).artifacts).toHaveLength(1);
      expect((await reopened.read()).activity).toHaveLength(3);
      expect((await reopened.read()).createRequests).toHaveLength(3);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
