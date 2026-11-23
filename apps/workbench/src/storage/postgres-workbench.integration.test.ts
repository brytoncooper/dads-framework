import { randomUUID } from "node:crypto";
import { createPostgresConnection } from "@dads-framework/postgres";
import { PostgresAuthorization, relationshipSchemaMigration } from "@dads-framework/postgres-access";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { workbenchAccessModel } from "../access.js";
import { startWorkbenchServer } from "../server.js";
import { createPostgresWorkbench } from "../create-workbench.js";
import { initializePostgresWorkbenchSchema } from "./postgres-workbench-schema.js";
import { PostgresWorkbenchStore } from "./postgres-workbench-store.js";
import type { PendingAuthorizationChange } from "./workbench-state.js";

const alice = { type: "user", id: "alice" };
const bob = { type: "user", id: "bob" };
const page = { page: 1, perPage: 20 };
const workspaceInput = {
  requestKey: "postgres-workspace-test",
  name: "Shared",
  description: "",
};
const taskInput = {
  requestKey: "postgres-task-test",
  title: "Read",
  description: "",
};

describe.runIf(process.env["WORKBENCH_POSTGRES_INTEGRATION"] === "1")("Workbench in one Postgres transaction", () => {
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    cleanup = postgres.stop;
    await postgres.pool.query(relationshipSchemaMigration.sql);
  }, 90_000);

  afterAll(async () => {
    await cleanup?.();
  });

  async function open(namespace: string) {
    const database = createPostgresConnection(
      { schema: {}, connectionString: postgres.connectionString },
      { error: () => undefined },
    );
    await initializePostgresWorkbenchSchema(database.drizzle, namespace);
    const authorization = new PostgresAuthorization({
      model: workbenchAccessModel,
      namespace,
      executor: database.pool,
    });
    const options = { database: database.drizzle, authorization, namespace };
    return {
      close: database.close,
      authorization,
      store: new PostgresWorkbenchStore(options),
      operations: createPostgresWorkbench({
        ...options,
        clock: () => new Date().toISOString(),
        createId: randomUUID,
      }).operations,
    };
  }

  it("isolates tenant lists and inherited task, claim, artifact and activity access after revoke", async () => {
    const app = await open("wb_revoke");
    try {
      const work = await app.operations.createWorkspace(alice, workspaceInput);
      const another = await app.operations.createWorkspace(bob, {
        ...workspaceInput,
        name: "Private",
      });
      const task = await app.operations.createTask(alice, work.id, taskInput);
      await app.operations.createArtifact(alice, task.id, {
        requestKey: "postgres-artifact-test",
        content: "Evidence",
        name: "proof.txt",
      });
      await expect(app.operations.listWorkspaces(bob, undefined, page)).resolves.toMatchObject({ data: [another] });
      await expect(app.operations.listTasks(bob, work.id, undefined, page)).resolves.toMatchObject({ data: [] });
      await app.operations.grantMember(alice, work.id, bob.id);
      await app.operations.claimTask(bob, task.id);
      await expect(app.operations.getTask(bob, task.id)).resolves.toMatchObject({ claimedBy: "bob" });
      await expect(app.operations.listArtifacts(bob, task.id, undefined, page)).resolves.toMatchObject({
        data: [{ name: "proof.txt" }],
      });
      await app.operations.revokeMember(alice, work.id, bob.id);
      await expect(app.operations.getTask(bob, task.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(app.operations.claimTask(bob, task.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(app.operations.listTasks(bob, work.id, undefined, page)).resolves.toMatchObject({ data: [] });
      await expect(app.operations.listArtifacts(bob, task.id, undefined, page)).resolves.toMatchObject({ data: [] });
      await expect(app.operations.listActivity(bob, work.id, undefined, page)).resolves.toMatchObject({ data: [] });
    } finally {
      await app.close();
    }
  });

  it("returns only the requested task page with an exact visible total over HTTP", async () => {
    const app = await open("wb_task_page");
    try {
      const workspace = await app.operations.createWorkspace(alice, workspaceInput);
      await app.operations.grantMember(alice, workspace.id, bob.id);
      const first = await app.operations.createTask(alice, workspace.id, taskInput);
      const second = await app.operations.createTask(alice, workspace.id, {
        ...taskInput,
        requestKey: "postgres-second-task-test",
      });
      const neighbor = await app.operations.createWorkspace(bob, workspaceInput);
      await app.operations.createTask(bob, neighbor.id, taskInput);
      await app.store.transaction((state) => {
        state.tasks.splice(1, 0, {
          ...first,
          id: "missing-task-relationship",
        });
      });

      const server = await startWorkbenchServer({
        store: app.store,
        authorization: app.authorization,
        port: 0,
      });
      try {
        const list = () =>
          fetch(`${server.url}/api/workspaces/${workspace.id}/tasks?page=2&perPage=1`, {
            headers: { "x-workbench-user": bob.id },
          });
        const visible = await list();
        expect(visible.status).toBe(200);
        expect(await visible.json()).toMatchObject({
          data: [second],
          meta: { page: 2, perPage: 1, total: 2, pageCount: 2 },
        });
        await app.operations.revokeMember(alice, workspace.id, bob.id);
        const denied = await list();
        expect(denied.status).toBe(200);
        expect(await denied.json()).toMatchObject({
          data: [],
          meta: { total: 0, pageCount: 0 },
        });
      } finally {
        await server.stop();
      }
    } finally {
      await app.close();
    }
  });

  it("reopens committed state and replays the same create request without adding another workspace", async () => {
    const first = await open("wb_restart");
    const created = await first.operations.createWorkspace(alice, workspaceInput).finally(first.close);
    const second = await open("wb_restart");
    try {
      await expect(second.operations.createWorkspace(alice, workspaceInput)).resolves.toEqual(created);
      await expect(second.operations.listWorkspaces(alice, undefined, page)).resolves.toMatchObject({
        data: [created],
      });
      expect((await second.store.read()).workspaces).toHaveLength(1);
      expect((await second.store.read()).pendingAuthorizationChanges).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("rolls back Workbench state when tuple projection fails", async () => {
    const app = await open("wb_rollback");
    try {
      const created = await app.operations.createWorkspace(alice, workspaceInput);
      const before = await app.store.read();
      const invalidChange = z
        .custom<PendingAuthorizationChange>(() => true)
        .parse({
          version: 1,
          operationId: "bad-fact",
          writes: [
            {
              resource: { type: "workspace", id: created.id },
              relation: "unknown_relation",
              subject: alice,
            },
          ],
          deletes: [],
        });
      await expect(
        app.store.commitMutation((state) => {
          state.workspaces = [];
          return {
            result: undefined,
            authorizationChanges: [invalidChange],
          };
        }),
      ).rejects.toThrow("Invalid authorization relationship");
      expect(await app.store.read()).toEqual(before);
    } finally {
      await app.close();
    }
  });
});
