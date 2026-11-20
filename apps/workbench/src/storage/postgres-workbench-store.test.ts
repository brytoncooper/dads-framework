import { applyWorkbenchRelationships } from "../operations/workbench-authorization.js";
import { workbenchFact } from "../access.js";
import { WorkbenchMemoryAuthorization } from "../testing/workbench-memory-authorization.js";
import { describe, expect, it } from "vitest";
import { workbenchWorkspace, type WorkbenchAuthorization } from "../access.js";
import { createWorkbench } from "../create-workbench.js";
import { WorkbenchError } from "../operations/workbench-error.js";
import { createAuthorizationDouble } from "../testing/authorization-double.js";
import {
  POSTGRES_WORKBENCH_SCHEMA_VERSION,
  POSTGRES_WORKBENCH_STATE_TABLE,
  postgresWorkbenchSchemaSql,
} from "./postgres-workbench-schema.js";
import { MemoryWorkbenchStore } from "./memory-workbench-store.js";
import {
  type SameStoreAuthorizedWorkbenchMutation,
  type SameStoreAuthorizingWorkbenchStore,
  type WorkbenchMutation,
} from "./workbench-store.js";
import { workbenchState, type WorkbenchState } from "./workbench-state.js";

const alice = { type: "user", id: "alice" };

class InstrumentedSameStore
  extends MemoryWorkbenchStore
  implements SameStoreAuthorizingWorkbenchStore
{
  readonly events: string[] = [];

  constructor(private readonly scopedAuthorization: WorkbenchAuthorization) {
    super();
  }

  override commitMutation<Result>(
    mutation: (state: WorkbenchState) => WorkbenchMutation<Result>,
  ): Promise<Result> {
    void mutation;
    return Promise.reject(
      new Error("Same-store operations must not use the legacy outbox."),
    );
  }

  async commitAuthorizedMutation<Result>(
    request: SameStoreAuthorizedWorkbenchMutation<Result>,
  ): Promise<Result> {
    const state = await this.read();
    const target = request.authorization.target(state);
    if (target === undefined) {
      if (request.authorization.kind !== "fresh-create")
        throw new Error("Protected mutations must resolve a target.");
    } else {
      this.events.push("scoped-can");
      if (
        !(await this.scopedAuthorization.check({
          ...target,
          subject: request.subject,
        }))
      )
        throw new WorkbenchError("NOT_FOUND");
    }
    const committed = request.mutation(state);
    for (const change of committed.authorizationChanges) {
      this.events.push("scoped-project");
      await applyWorkbenchRelationships(this.scopedAuthorization, change);
    }
    this.state = workbenchState.parse(state);
    return committed.result;
  }
}

describe("Postgres Workbench schema", () => {
  it("is explicit, versioned, and namespaced without constructor-owned DDL", () => {
    expect(POSTGRES_WORKBENCH_SCHEMA_VERSION).toBe(1);
    expect(POSTGRES_WORKBENCH_STATE_TABLE).toBe("dads_workbench_state");
    expect(postgresWorkbenchSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS dads_workbench_state",
    );
    expect(postgresWorkbenchSchemaSql).toContain("namespace TEXT PRIMARY KEY");
    expect(postgresWorkbenchSchemaSql).toContain("document JSONB NOT NULL");
  });
});

describe("same-store Workbench authorization capability", () => {
  it("uses scoped authorization before state mutation and never the root or outbox path", async () => {
    const scopedAuthorization = new WorkbenchMemoryAuthorization();
    let rootCanCalls = 0;
    const rootAuthorization = createAuthorizationDouble(scopedAuthorization, {
      check: () => {
        rootCanCalls += 1;
        return Promise.reject(
          new Error("Root authorization must not be used."),
        );
      },
    });
    const store = new InstrumentedSameStore(scopedAuthorization);
    let sequence = 0;
    const app = createWorkbench({
      store,
      authorization: rootAuthorization,
      clock: () => "2026-09-02T12:00:00.000Z",
      createId: () => `same-store-${String(++sequence)}`,
    });
    const body = {
      requestKey: "same-store-create-request",
      name: "One workspace",
      description: "",
    };

    const workspace = await app.operations.createWorkspace(alice, body);
    expect(store.events).toEqual(["scoped-project"]);
    expect(rootCanCalls).toBe(0);
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);

    store.events.length = 0;
    await app.operations.grantMember(alice, workspace.id, "bob");
    expect(store.events).toEqual(["scoped-can", "scoped-project"]);
    expect(rootCanCalls).toBe(0);

    store.events.length = 0;
    await expect(app.operations.createWorkspace(alice, body)).resolves.toEqual(
      workspace,
    );
    expect(store.events).toEqual(["scoped-can"]);
    expect(rootCanCalls).toBe(0);

    await scopedAuthorization.deleteExact(
      workbenchFact(workbenchWorkspace.roles.owner, workspace.id, alice),
    );
    const beforeDenial = await store.read();
    store.events.length = 0;
    await expect(
      app.operations.updateWorkspace(alice, workspace.id, {
        description: "Denied",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.read()).toEqual(beforeDenial);
    expect(store.events).toEqual(["scoped-can"]);
    expect(rootCanCalls).toBe(0);
  });

  it("leaves the root-authorization outbox path intact for legacy stores", async () => {
    const backing = new WorkbenchMemoryAuthorization();
    let rootCanCalls = 0;
    let relationshipWrites = 0;
    const authorization = createAuthorizationDouble(backing, {
      check: (query) => {
        rootCanCalls += 1;
        return backing.check(query);
      },
      writeRelationships: (relationships) => {
        relationshipWrites += 1;
        return backing.writeRelationships(relationships);
      },
    });
    const store = new MemoryWorkbenchStore();
    let sequence = 0;
    const app = createWorkbench({
      store,
      authorization,
      clock: () => "2026-09-02T12:00:00.000Z",
      createId: () => `legacy-${String(++sequence)}`,
    });
    const workspace = await app.operations.createWorkspace(alice, {
      requestKey: "legacy-create-request",
      name: "Legacy workspace",
      description: "",
    });
    await app.operations.updateWorkspace(alice, workspace.id, {
      name: "Updated",
    });

    expect(rootCanCalls).toBe(1);
    expect(relationshipWrites).toBe(1);
    expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
  });

  it("keeps deleted create replays as conflicts after resolving locked state", async () => {
    const authorization = new WorkbenchMemoryAuthorization();
    const store = new InstrumentedSameStore(authorization);
    let sequence = 0;
    const app = createWorkbench({
      store,
      authorization,
      clock: () => "2026-09-02T12:00:00.000Z",
      createId: () => `deleted-replay-${String(++sequence)}`,
    });
    const body = {
      requestKey: "deleted-replay-request",
      name: "Deleted workspace",
      description: "",
    };
    const workspace = await app.operations.createWorkspace(alice, body);
    await app.operations.deleteWorkspace(alice, workspace.id);

    store.events.length = 0;
    await expect(
      app.operations.createWorkspace(alice, body),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.events).toEqual([]);
  });
});
