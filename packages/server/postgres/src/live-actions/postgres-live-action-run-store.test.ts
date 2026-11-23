import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { PostgresClient } from "../lib/connect-postgres-client.js";
import type { PgPool } from "../lib/database-service.js";
import type { LiveActionQueryClient, LiveActionRunRecord } from "./live-action-run-types.js";
import { applyLiveActionRunsMigration, liveActionRunsMigration } from "./live-action-runs-migration.js";
import { liveActionRunsTable } from "./live-action-runs.table.js";
import { createPostgresLiveActionRunStore } from "./postgres-live-action-run-store.js";

type CapturedQuery = {
  readonly text: string;
  readonly values: unknown[] | undefined;
};

function createRecordingClient(nextRows: readonly unknown[] = []): {
  readonly client: LiveActionQueryClient;
  readonly queries: CapturedQuery[];
  setRows: (rows: readonly unknown[]) => void;
} {
  let rows = nextRows;
  const queries: CapturedQuery[] = [];
  return {
    queries,
    setRows(updated: readonly unknown[]) {
      rows = updated;
    },
    client: {
      query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

const SAMPLE_STARTED = new Date("2026-06-01T10:00:00.000Z");
const SAMPLE_FINISHED = new Date("2026-06-01T10:00:05.000Z");

const SAMPLE_RUN: LiveActionRunRecord = {
  id: "01990000-0000-7000-8000-000000000010",
  actionName: "cache.invalidate",
  dangerLevel: "mutating",
  actorType: "operator",
  actorId: "op-42",
  reason: "Refresh stale invoice projection",
  redactedInput: { workspaceId: "ws-1", token: "[REDACTED]" },
  outcome: "running",
  summary: null,
  errorMessage: null,
  startedAt: SAMPLE_STARTED,
  finishedAt: null,
};

describe("liveActionRunsMigration & liveActionRunsTable", () => {
  it("defines an idempotent CREATE TABLE migration matching liveActionRunsTable columns", async () => {
    const recorder = createRecordingClient();
    await applyLiveActionRunsMigration(recorder.client);

    expect(recorder.queries).toHaveLength(1);
    expect(recorder.queries[0]?.text).toBe(liveActionRunsMigration);
    expect(liveActionRunsMigration).toContain("CREATE TABLE IF NOT EXISTS live_action_runs");

    const tableConfig = getTableConfig(liveActionRunsTable);
    expect(tableConfig.name).toBe("live_action_runs");
    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      "id",
      "action_name",
      "danger_level",
      "actor_type",
      "actor_id",
      "reason",
      "redacted_input",
      "outcome",
      "summary",
      "error_message",
      "started_at",
      "finished_at",
    ]);
  });
});

describe("createPostgresLiveActionRunStore", () => {
  it("inserts a started run with JSON-serialized redacted input", async () => {
    const recorder = createRecordingClient();
    const store = createPostgresLiveActionRunStore(recorder.client);

    await store.recordStart(SAMPLE_RUN);

    expect(recorder.queries).toHaveLength(1);
    expect(recorder.queries[0]?.text).toContain("INSERT INTO live_action_runs");
    expect(recorder.queries[0]?.values).toEqual([
      SAMPLE_RUN.id,
      SAMPLE_RUN.actionName,
      SAMPLE_RUN.dangerLevel,
      SAMPLE_RUN.actorType,
      SAMPLE_RUN.actorId,
      SAMPLE_RUN.reason,
      JSON.stringify(SAMPLE_RUN.redactedInput),
      "running",
      null,
      null,
      SAMPLE_STARTED,
      null,
    ]);
  });

  it("updates outcome, summary, error message, and finished_at on recordFinish", async () => {
    const recorder = createRecordingClient();
    const store = createPostgresLiveActionRunStore(recorder.client);

    await store.recordFinish({
      id: SAMPLE_RUN.id,
      outcome: "succeeded",
      summary: "Invalidated 4 keys",
      errorMessage: null,
      finishedAt: SAMPLE_FINISHED,
    });

    expect(recorder.queries).toHaveLength(1);
    expect(recorder.queries[0]?.text).toContain("UPDATE live_action_runs");
    expect(recorder.queries[0]?.values).toEqual([
      SAMPLE_RUN.id,
      "succeeded",
      "Invalidated 4 keys",
      null,
      SAMPLE_FINISHED,
    ]);
  });

  it("maps rows returned by getById and returns undefined when absent", async () => {
    const recorder = createRecordingClient([]);
    const store = createPostgresLiveActionRunStore(recorder.client);

    expect(await store.getById(SAMPLE_RUN.id)).toBeUndefined();

    recorder.setRows([
      {
        id: SAMPLE_RUN.id,
        action_name: SAMPLE_RUN.actionName,
        danger_level: SAMPLE_RUN.dangerLevel,
        actor_type: SAMPLE_RUN.actorType,
        actor_id: SAMPLE_RUN.actorId,
        reason: SAMPLE_RUN.reason,
        redacted_input: SAMPLE_RUN.redactedInput,
        outcome: "succeeded",
        summary: "Done",
        error_message: null,
        started_at: SAMPLE_STARTED.toISOString(),
        finished_at: SAMPLE_FINISHED,
      },
    ]);

    const found = await store.getById(SAMPLE_RUN.id);
    expect(found).toEqual({
      ...SAMPLE_RUN,
      outcome: "succeeded",
      summary: "Done",
      finishedAt: SAMPLE_FINISHED,
    });
  });

  it("lists recent runs with default limit and optional actionName filter", async () => {
    const recorder = createRecordingClient([
      {
        id: SAMPLE_RUN.id,
        action_name: SAMPLE_RUN.actionName,
        danger_level: SAMPLE_RUN.dangerLevel,
        actor_type: SAMPLE_RUN.actorType,
        actor_id: SAMPLE_RUN.actorId,
        reason: SAMPLE_RUN.reason,
        redacted_input: { ok: true },
        outcome: "failed",
        summary: null,
        error_message: "Timeout",
        started_at: SAMPLE_STARTED,
        finished_at: SAMPLE_FINISHED,
      },
    ]);
    const store = createPostgresLiveActionRunStore(recorder.client);

    const allRecent = await store.listRecent();
    expect(allRecent).toHaveLength(1);
    expect(allRecent[0]?.errorMessage).toBe("Timeout");
    expect(recorder.queries[0]?.text).not.toContain("WHERE action_name");
    expect(recorder.queries[0]?.values).toEqual([50]);

    await store.listRecent({ actionName: "cache.invalidate", limit: 10 });
    expect(recorder.queries[1]?.text).toContain("WHERE action_name = $1");
    expect(recorder.queries[1]?.values).toEqual(["cache.invalidate", 10]);
  });

  it("rejects malformed rows and invalid inputs at the boundary", async () => {
    const recorder = createRecordingClient([
      {
        id: SAMPLE_RUN.id,
        action_name: SAMPLE_RUN.actionName,
        danger_level: SAMPLE_RUN.dangerLevel,
        actor_type: SAMPLE_RUN.actorType,
        actor_id: SAMPLE_RUN.actorId,
        reason: SAMPLE_RUN.reason,
        redacted_input: {},
        outcome: "unexpected-outcome",
        summary: null,
        error_message: null,
        started_at: SAMPLE_STARTED,
        finished_at: null,
      },
    ]);
    const store = createPostgresLiveActionRunStore(recorder.client);

    await expect(store.getById(SAMPLE_RUN.id)).rejects.toThrow();
    await expect(store.listRecent({ limit: 0 })).rejects.toThrow();
    await expect(store.getById("")).rejects.toThrow();

    // Compile-time check: both PostgresClient and PgPool satisfy LiveActionQueryClient.
    const acceptStoreClient = (c: PostgresClient, p: PgPool): void => {
      createPostgresLiveActionRunStore(c);
      createPostgresLiveActionRunStore(p);
    };
    expect(typeof acceptStoreClient).toBe("function");
  });
});
