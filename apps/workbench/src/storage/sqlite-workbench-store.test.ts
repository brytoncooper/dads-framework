import { testAuthorizationFault } from "../testing/authorization-double.js";
import { WorkbenchMemoryAuthorization } from "../testing/workbench-memory-authorization.js";
/** Proves resources and pending authorization changes survive a real SQLite connection restart together. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workbenchUser, workbenchWorkspace } from "../access.js";
import { createWorkbench } from "../create-workbench.js";
import { createAuthorizationDouble } from "../testing/authorization-double.js";
import { SqliteWorkbenchStore } from "./sqlite-workbench-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SQLite workbench storage", () => {
  it("recovers a resource and its failed ownership write across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dads-workbench-sqlite-"));
    directories.push(directory);
    const path = join(directory, "workbench.sqlite");
    const store = new SqliteWorkbenchStore(path);
    const authorization = new WorkbenchMemoryAuthorization();
    const unavailableAuthorization = createAuthorizationDouble(authorization, {
      writeRelationships: () =>
        Promise.reject(
          testAuthorizationFault("UNAVAILABLE", "Backend unavailable"),
        ),
    });
    let sequence = 0;
    const options = {
      clock: () => "2026-08-31T12:00:00.000Z",
      createId: () => `restart-${String(++sequence)}`,
    };
    const first = createWorkbench({
      ...options,
      store,
      authorization: unavailableAuthorization,
    });
    await expect(
      first.operations.createWorkspace(
        { type: "user", id: "alice" },
        {
          requestKey: "test-create-request-00024",
          name: "Persist me",
          description: "",
        },
      ),
    ).rejects.toMatchObject({ code: "RELATIONSHIPS_PENDING" });
    expect((await store.read()).workspaces).toHaveLength(1);
    expect((await store.read()).pendingAuthorizationChanges).toHaveLength(1);
    store.close();

    const reopened = new SqliteWorkbenchStore(path);
    try {
      expect((await reopened.read()).workspaces).toHaveLength(1);
      expect((await reopened.read()).pendingAuthorizationChanges).toHaveLength(
        1,
      );
      const second = createWorkbench({
        ...options,
        store: reopened,
        authorization,
      });
      await second.operations.synchronize();
      expect((await reopened.read()).pendingAuthorizationChanges).toEqual([]);
      const workspace = (await reopened.read()).workspaces[0];
      if (!workspace) throw new Error("Missing restored workspace");
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
    } finally {
      reopened.close();
    }
  });

  it("rolls back invalid transactions and does not expose mutable stored snapshots", async () => {
    const store = new SqliteWorkbenchStore(":memory:");
    try {
      await expect(
        store.transaction((state) => {
          state.pendingAuthorizationChanges.push({
            version: 1,
            operationId: "queued",
            writes: [],
            deletes: [],
          });
        }),
      ).rejects.toThrow();
      expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
      const snapshot = await store.read();
      snapshot.pendingAuthorizationChanges.push({
        version: 1,
        operationId: "not-stored",
        writes: [],
        deletes: [],
      });
      expect((await store.read()).pendingAuthorizationChanges).toEqual([]);
    } finally {
      store.close();
    }
  });
});
