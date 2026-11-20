import type { PendingAuthorizationChange } from "./storage/workbench-state.js";
import { testAuthorizationFault } from "./testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
/** A failed relationship write must never report mutation success or permit reads through stale grants. */
import {
  executeWorkbenchRoute,
  operationOf,
} from "./testing/workbench-request.js";
import { describe, expect, it } from "vitest";
import {
  workbenchTask,
  workbenchUser,
  workbenchWorkspace,
  type WorkbenchRelationship,
} from "./access.js";
import { createWorkbench } from "./create-workbench.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import {
  workbenchState,
  type WorkbenchState,
} from "./storage/workbench-state.js";
import type { WorkbenchMutation } from "./storage/workbench-store.js";
import { createAuthorizationDouble } from "./testing/authorization-double.js";

function setup() {
  let unavailable = false;
  let sequence = 0;
  const storedAuthorization = new WorkbenchMemoryAuthorization();
  const authorization = createAuthorizationDouble(storedAuthorization, {
    writeRelationships: (relationships: readonly WorkbenchRelationship[]) =>
      unavailable
        ? Promise.reject(testAuthorizationFault("UNAVAILABLE", "Unavailable"))
        : storedAuthorization.writeRelationships(relationships),
    deleteRelationships: (filter) =>
      unavailable
        ? Promise.reject(testAuthorizationFault("UNAVAILABLE", "Unavailable"))
        : storedAuthorization.deleteRelationships(filter),
  });
  const store = new MemoryWorkbenchStore();
  const app = createWorkbench({
    store,
    authorization,
    clock: () => "2026-08-31T12:00:00.000Z",
    createId: () => `pending-${String(++sequence)}`,
  });
  return {
    app,
    store,
    authorization,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

const alice = { type: "user", id: "alice" };
const bob = { type: "user", id: "bob" };

class ProjectingMemoryStore extends MemoryWorkbenchStore {
  constructor(
    private readonly project: (
      change: PendingAuthorizationChange,
    ) => Promise<void>,
  ) {
    super();
  }

  override async commitMutation<Result>(
    mutation: (state: WorkbenchState) => WorkbenchMutation<Result>,
  ): Promise<Result> {
    const next = await this.read();
    const committed = mutation(next);
    for (const change of committed.authorizationChanges)
      await this.project(change);
    this.state = workbenchState.parse(next);
    return committed.result;
  }
}

describe("pending relationship recovery", () => {
  it("does not commit domain state when same-store projection fails", async () => {
    const authorization = new WorkbenchMemoryAuthorization();
    const store = new ProjectingMemoryStore(() =>
      Promise.reject(testAuthorizationFault("UNAVAILABLE", "Unavailable")),
    );
    const app = createWorkbench({
      store,
      authorization,
      clock: () => "2026-08-31T12:00:00.000Z",
      createId: () => "same-store-failure",
    });

    await expect(
      app.operations.createWorkspace(alice, {
        requestKey: "same-store-projection-failure",
        name: "No partial commit",
        description: "",
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await store.read()).workspaces).toEqual([]);
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
    expect(
      await authorization.listDirectSubjects({
        resource: {
          type: workbenchWorkspace.entity.wireName,
          id: "same-store-failure",
        },
        relation: workbenchWorkspace.roles.owner.roleName,
      }),
    ).toEqual([]);
  });

  it("replays an applied relationship safely when local acknowledgement fails", async () => {
    class AcknowledgementFailingStore extends MemoryWorkbenchStore {
      private failAcknowledgement = true;

      override transaction<Result>(
        change: (state: WorkbenchState) => Result,
      ): Promise<Result> {
        return super.transaction((state) => {
          const hadPending = state.pendingAuthorizationChanges.length > 0;
          const result = change(state);
          if (
            this.failAcknowledgement &&
            hadPending &&
            state.pendingAuthorizationChanges.length === 0
          ) {
            this.failAcknowledgement = false;
            throw new Error("Simulated local acknowledgement failure");
          }
          return result;
        });
      }
    }
    const store = new AcknowledgementFailingStore();
    const authorization = new WorkbenchMemoryAuthorization();
    let sequence = 0;
    const app = createWorkbench({
      store,
      authorization,
      clock: () => "2026-08-31T12:00:00.000Z",
      createId: () => `ack-${String(++sequence)}`,
    });
    await expect(
      app.operations.createWorkspace(alice, {
        requestKey: "test-create-request-00017",
        name: "Recover acknowledgement",
        description: "",
      }),
    ).rejects.toThrow();
    expect((await store.read()).pendingAuthorizationChanges).toHaveLength(1);
    const workspace = (await store.read()).workspaces[0];
    if (!workspace) throw new Error("Missing created workspace");
    expect(
      await authorization.listDirectSubjects({
        resource: {
          type: workbenchWorkspace.entity.wireName,
          id: workspace.id,
        },
        relation: workbenchWorkspace.roles.owner.roleName,
      }),
    ).toEqual([{ type: workbenchUser.wireName, id: alice.id }]);
    await app.operations.synchronize();
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
    expect(
      await authorization.listDirectSubjects({
        resource: {
          type: workbenchWorkspace.entity.wireName,
          id: workspace.id,
        },
        relation: workbenchWorkspace.roles.owner.roleName,
      }),
    ).toEqual([{ type: workbenchUser.wireName, id: alice.id }]);
  });

  it("keeps failed ownership creation pending and retries it idempotently", async () => {
    const { app, store, authorization, setUnavailable } = setup();
    setUnavailable(true);
    await expect(
      app.operations.createWorkspace(alice, {
        requestKey: "test-create-request-00018",
        name: "Pending",
        description: "",
      }),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    expect((await store.read()).workspaces).toHaveLength(1);
    expect((await store.read()).pendingAuthorizationChanges).toHaveLength(1);
    const workspace = (await store.read()).workspaces[0];
    if (!workspace) throw new Error("Missing pending workspace");
    await expect(
      app.operations.getWorkspace(alice, workspace.id),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    setUnavailable(false);
    await app.operations.synchronize();
    await app.operations.synchronize();
    expect((await store.read()).workspaces).toHaveLength(1);
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
    expect(
      await authorization.listDirectSubjects({
        resource: {
          type: workbenchWorkspace.entity.wireName,
          id: workspace.id,
        },
        relation: workbenchWorkspace.roles.owner.roleName,
      }),
    ).toEqual([{ type: workbenchUser.wireName, id: alice.id }]);
  });

  it("blocks reads while revocation is pending, then removes inherited claim access", async () => {
    const { app, store, setUnavailable } = setup();
    const workspace = await app.operations.createWorkspace(alice, {
      requestKey: "test-create-request-00019",
      name: "Revoke",
      description: "",
    });
    await app.operations.grantMember(alice, workspace.id, bob.id);
    const task = await app.operations.createTask(alice, workspace.id, {
      requestKey: "test-create-request-00020",
      title: "Claim",
      description: "",
    });
    await app.operations.claimTask(bob, task.id);
    setUnavailable(true);
    await expect(
      app.operations.revokeMember(alice, workspace.id, bob.id),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    expect(
      (await store.read()).members.find((member) => member.userId === bob.id),
    ).toBeUndefined();
    expect((await store.read()).pendingAuthorizationChanges).toHaveLength(1);
    await expect(app.operations.getTask(bob, task.id)).rejects.toMatchObject({
      code: "RELATIONSHIPS_PENDING",
    });
    const route = app.routes.find((entry) => operationOf(entry) === "getTask");
    if (!route) throw new Error("Missing task route");
    expect(
      await executeWorkbenchRoute(
        route,
        {
          subject: bob,
          params: { taskId: task.id },
        },
        app,
      ),
    ).toMatchObject({ kind: "failure", status: 503 });
    setUnavailable(false);
    await app.operations.synchronize();
    await expect(app.operations.getTask(bob, task.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(app.operations.claimTask(bob, task.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const listRoute = app.routes
      .filter((entry) => entry.kind === "route")
      .find((entry) => operationOf(entry) === "listTasks");
    const listOutcome = await executeWorkbenchRoute(
      listRoute,
      {
        params: { workspaceId: workspace.id },
        query: { page: "1", perPage: "25" },
        body: undefined,
        subject: bob,
        requestId: "pending-list",
      },
      app,
    );
    expect(listOutcome).toMatchObject({ kind: "success", data: [] });
  });

  it("rejects two simultaneous claims without creating independent access relationships", async () => {
    const { app, authorization } = setup();
    const workspace = await app.operations.createWorkspace(alice, {
      requestKey: "test-create-request-00021",
      name: "Claims",
      description: "",
    });
    await app.operations.grantMember(alice, workspace.id, bob.id);
    const task = await app.operations.createTask(alice, workspace.id, {
      requestKey: "test-create-request-00022",
      title: "One claimant",
      description: "",
    });
    const claims = await Promise.allSettled([
      app.operations.claimTask(alice, task.id),
      app.operations.claimTask(bob, task.id),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await authorization.listDirectSubjects({
        resource: { type: workbenchTask.entity.wireName, id: task.id },
        relation: workbenchTask.roles.workspace.roleName,
      }),
    ).toEqual([{ type: workbenchWorkspace.entity.wireName, id: workspace.id }]);
  });
});
