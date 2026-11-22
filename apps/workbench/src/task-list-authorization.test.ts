import type { PermissionQuery } from "@dads-framework/authorization";
import { expect, it } from "vitest";
import {
  workbenchFact,
  workbenchTask,
  workbenchUser,
  workbenchWorkspace,
} from "./access.js";
import { startWorkbenchServer } from "./server.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { testAuthorizationFault } from "./testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";

const actor = { type: workbenchUser.wireName, id: "alice" };
const workspaceId = "task-list-workspace";
const otherWorkspaceId = "other-workspace";
const grant = workbenchFact(
  workbenchWorkspace.roles.member,
  workspaceId,
  actor,
);
const time = "2026-11-19T12:00:00.000Z";

class TaskListAuthorization extends WorkbenchMemoryAuthorization {
  readonly batches: string[][] = [];
  afterBatch: (
    answers: readonly boolean[],
  ) => readonly boolean[] | Promise<readonly boolean[]> = (answers) => answers;

  async checkMany(queries: readonly PermissionQuery[]) {
    this.batches.push(queries.map((query) => query.resource.id));
    const answers = await Promise.all(
      queries.map((query) => this.check(query)),
    );
    return this.afterBatch(answers);
  }
}

async function startTaskList() {
  const authorization = new TaskListAuthorization();
  const store = new MemoryWorkbenchStore();
  await store.transaction((state) => {
    for (const { id, parent } of [
      { id: "visible-first", parent: workspaceId },
      { id: "missing-relationship", parent: workspaceId },
      { id: "visible-second", parent: workspaceId },
      { id: "foreign-task", parent: otherWorkspaceId },
    ]) {
      state.tasks.push({
        id,
        workspaceId: parent,
        title: id,
        description: "",
        status: "todo",
        claimedBy: null,
        createdAt: time,
        updatedAt: time,
      });
    }
  });
  const elsewhere = {
    type: workbenchWorkspace.wireName,
    id: otherWorkspaceId,
  };
  await authorization.writeRelationships([
    grant,
    workbenchFact(workbenchWorkspace.roles.member, otherWorkspaceId, actor),
    workbenchFact(workbenchTask.roles.workspace, "visible-first", elsewhere),
    workbenchFact(workbenchTask.roles.workspace, "visible-second", elsewhere),
    workbenchFact(workbenchTask.roles.workspace, "foreign-task", elsewhere),
  ]);
  const app = await startWorkbenchServer({ authorization, store, port: 0 });
  return {
    ...app,
    authorization,
    list: () =>
      fetch(`${app.url}/api/workspaces/${workspaceId}/tasks?page=2&perPage=1`, {
        headers: { "x-workbench-user": actor.id },
      }),
  };
}

it("checks workspace task candidates in one ordered batch before paginating", async () => {
  const app = await startTaskList();
  try {
    const response = await app.list();
    expect(response.status).toBe(200);
    expect(app.authorization.batches).toEqual([
      ["visible-first", "missing-relationship", "visible-second"],
    ]);
    expect(await response.json()).toMatchObject({
      data: [{ id: "visible-second" }],
      meta: { page: 2, perPage: 1, total: 2 },
    });
  } finally {
    await app.stop();
  }
});

it("denies the page if workspace access is revoked during the task batch", async () => {
  const app = await startTaskList();
  try {
    app.authorization.afterBatch = async (answers) => {
      await app.authorization.deleteExact(grant);
      return answers;
    };
    const response = await app.list();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [],
      meta: { total: 0 },
    });
  } finally {
    await app.stop();
  }
});

it.each([
  { failure: "outage", status: 503, code: "AUTHORIZATION_UNAVAILABLE" },
  { failure: "missing decision", status: 500, code: "INTERNAL_ERROR" },
])("fails closed on a batch $failure", async ({ failure, status, code }) => {
  const app = await startTaskList();
  try {
    app.authorization.afterBatch = () => {
      if (failure === "outage")
        throw testAuthorizationFault("UNAVAILABLE", "Private diagnostic");
      return [true];
    };
    const response = await app.list();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  } finally {
    await app.stop();
  }
});
