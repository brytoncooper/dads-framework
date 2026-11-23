import { randomUUID } from "node:crypto";
import { createPostgresConnection } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { PostgresAuthorization, relationshipSchemaMigration } from "@dads-framework/postgres-access";
import { expect, it } from "vitest";
import { workbenchAccessModel, workbenchUser } from "../access.js";
import { createWorkbench } from "../create-workbench.js";
import { startWorkbenchServer } from "../server.js";
import { initializePostgresWorkbenchSchema } from "./postgres-workbench-schema.js";
import { PostgresWorkbenchStore } from "./postgres-workbench-store.js";

function latch() {
  let signal: () => void = () => {
    throw new Error("The commit latch was not initialized.");
  };
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { reached, signal };
}

it.runIf(process.env["WORKBENCH_POSTGRES_INTEGRATION"] === "1")(
  "returns a retryable conflict for a claim waiting behind a revocation and never replays it",
  { timeout: 90_000 },
  async () => {
    const postgres = await startUnmigratedTestPostgres();
    const url = new URL(postgres.connectionString);
    url.searchParams.set("application_name", "workbench-claim-proof");
    const database = createPostgresConnection(
      { schema: {}, connectionString: url.toString() },
      { error: () => undefined },
    );
    const namespace = "workbench_claim_proof";
    const authorization = new PostgresAuthorization({
      model: workbenchAccessModel,
      namespace,
      executor: database.pool,
    });
    const locked = latch();
    const release = latch();
    const options = { authorization, namespace, database: database.drizzle };
    const store = new PostgresWorkbenchStore(options);
    const revokingStore = new PostgresWorkbenchStore({
      ...options,
      database: {
        execute: database.drizzle.execute.bind(database.drizzle),
        transaction: (operation, config) =>
          database.drizzle.transaction(async (tx) => {
            const result = await operation(tx);
            locked.signal();
            await release.reached;
            return result;
          }, config),
      },
    });
    const application = {
      authorization,
      clock: () => new Date().toISOString(),
      createId: randomUUID,
    };
    const { operations } = createWorkbench({ ...application, store });
    const revoker = createWorkbench({ ...application, store: revokingStore });
    const alice = { type: workbenchUser.wireName, id: "alice" };
    const bob = { type: workbenchUser.wireName, id: "bob" };
    try {
      await postgres.pool.query(relationshipSchemaMigration.sql);
      await initializePostgresWorkbenchSchema(database.drizzle, namespace);
      const workspace = await operations.createWorkspace(alice, {
        requestKey: "concurrent-claim-workspace",
        name: "Workspace",
        description: "",
      });
      await operations.grantMember(alice, workspace.id, bob.id);
      const task = await operations.createTask(alice, workspace.id, {
        requestKey: "concurrent-claim-task",
        title: "Task",
        description: "",
      });
      const server = await startWorkbenchServer({
        store,
        authorization,
        port: 0,
      });
      try {
        const claim = () =>
          fetch(`${server.url}/api/tasks/${task.id}/claim`, {
            method: "POST",
            headers: {
              "x-workbench-user": bob.id,
              "content-type": "application/json",
            },
            body: "{}",
          });
        const revoke = revoker.operations.revokeMember(alice, workspace.id, bob.id);
        let inFlightClaim: Promise<Response> | undefined;
        try {
          await Promise.race([locked.reached, revoke]);
          inFlightClaim = claim();
          await expect
            .poll(
              async () => {
                const result = await postgres.pool.query<{ waiting: boolean }>(`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE application_name = 'workbench-claim-proof'
                  AND wait_event_type = 'Lock'
                  AND query LIKE '%FOR UPDATE%'
              ) AS waiting
            `);
                return result.rows[0]?.waiting;
              },
              { timeout: 5_000 },
            )
            .toBe(true);
          release.signal();
          await revoke;
          const conflict = await inFlightClaim;
          expect(conflict.status).toBe(409);
          expect(await conflict.json()).toMatchObject({
            error: { code: "POSTGRES_CONFLICT", details: { retryable: true } },
          });
          const retried = await claim();
          expect(retried.status).toBe(404);
          expect(await retried.json()).toMatchObject({
            error: { code: "RESOURCE_NOT_FOUND" },
          });
          const state = await store.read();
          expect(state.tasks).toEqual([task]);
          expect(state.members.some((member) => member.userId === bob.id)).toBe(false);
          expect(state.activity.some((event) => event.action === "task.claimed")).toBe(false);
        } finally {
          release.signal();
          await Promise.allSettled([revoke, inFlightClaim]);
        }
      } finally {
        await server.stop();
      }
    } finally {
      try {
        await database.close();
      } finally {
        await postgres.stop();
      }
    }
  },
);
