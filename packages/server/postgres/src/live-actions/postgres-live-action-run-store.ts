import { z } from "zod";
import type {
  FinishLiveActionRunInput,
  ListRecentLiveActionRunsOptions,
  LiveActionQueryClient,
  LiveActionRunRecord,
  LiveActionRunStore,
} from "./live-action-run-types.js";

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;

const liveActionDangerLevelSchema = z.enum(["safe", "cautious", "destructive"]);
const liveActionOutcomeSchema = z.enum(["running", "succeeded", "failed"]);

const pgTimestampSchema = z.union([z.date(), z.string().min(1)]).transform((value, ctx) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: "custom", message: "Invalid timestamp value in live_action_runs row" });
    return z.NEVER;
  }
  return date;
});

const liveActionRunRowSchema = z.object({
  id: z.string().min(1),
  action_name: z.string().min(1),
  danger_level: liveActionDangerLevelSchema,
  actor_type: z.string().min(1),
  actor_id: z.string().min(1),
  reason: z.string(),
  redacted_input: z.unknown(),
  outcome: liveActionOutcomeSchema,
  summary: z.string().nullable(),
  error_message: z.string().nullable(),
  started_at: pgTimestampSchema,
  finished_at: pgTimestampSchema.nullable(),
});

const startRunInputSchema = z.strictObject({
  id: z.string().min(1),
  actionName: z.string().min(1),
  dangerLevel: liveActionDangerLevelSchema,
  actorType: z.string().min(1),
  actorId: z.string().min(1),
  reason: z.string(),
  redactedInput: z.unknown(),
  outcome: liveActionOutcomeSchema,
  summary: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});

const finishRunInputSchema = z.strictObject({
  id: z.string().min(1),
  outcome: z.enum(["succeeded", "failed"]),
  summary: z.string().nullable(),
  errorMessage: z.string().nullable(),
  finishedAt: z.date(),
});

const listRecentOptionsSchema = z.strictObject({
  actionName: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_RECENT_LIMIT).optional(),
});

const SELECT_RUN_COLUMNS = `
  id,
  action_name,
  danger_level,
  actor_type,
  actor_id,
  reason,
  redacted_input,
  outcome,
  summary,
  error_message,
  started_at,
  finished_at
`.trim();

function mapLiveActionRunRow(rawRow: unknown): LiveActionRunRecord {
  const row = liveActionRunRowSchema.parse(rawRow);
  return {
    id: row.id,
    actionName: row.action_name,
    dangerLevel: row.danger_level,
    actorType: row.actor_type,
    actorId: row.actor_id,
    reason: row.reason,
    redactedInput: row.redacted_input,
    outcome: row.outcome,
    summary: row.summary,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function serializeRedactedInput(value: unknown): string {
  const encoded: unknown = JSON.stringify(value === undefined ? null : value);
  return typeof encoded === "string" ? encoded : "null";
}

/**
 * Creates a PostgreSQL-backed `LiveActionRunStore` persisting runs into the
 * `live_action_runs` table created by `liveActionRunsMigration`.
 */
export function createPostgresLiveActionRunStore(pool: LiveActionQueryClient): LiveActionRunStore {
  return {
    async recordStart(run: LiveActionRunRecord): Promise<void> {
      const valid = startRunInputSchema.parse(run);
      await pool.query(
        `INSERT INTO live_action_runs (
           id, action_name, danger_level, actor_type, actor_id, reason,
           redacted_input, outcome, summary, error_message, started_at, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
        [
          valid.id,
          valid.actionName,
          valid.dangerLevel,
          valid.actorType,
          valid.actorId,
          valid.reason,
          serializeRedactedInput(valid.redactedInput),
          valid.outcome,
          valid.summary,
          valid.errorMessage,
          valid.startedAt,
          valid.finishedAt,
        ],
      );
    },

    async recordFinish(input: FinishLiveActionRunInput): Promise<void> {
      const valid = finishRunInputSchema.parse(input);
      await pool.query(
        `UPDATE live_action_runs
         SET outcome = $2,
             summary = $3,
             error_message = $4,
             finished_at = $5
         WHERE id = $1`,
        [valid.id, valid.outcome, valid.summary, valid.errorMessage, valid.finishedAt],
      );
    },

    async getById(id: string): Promise<LiveActionRunRecord | undefined> {
      const validId = z.string().min(1).parse(id);
      const result = await pool.query(`SELECT ${SELECT_RUN_COLUMNS} FROM live_action_runs WHERE id = $1`, [validId]);
      const firstRow = result.rows[0];
      return firstRow === undefined ? undefined : mapLiveActionRunRow(firstRow);
    },

    async listRecent(options?: ListRecentLiveActionRunsOptions): Promise<readonly LiveActionRunRecord[]> {
      const valid = options === undefined ? {} : listRecentOptionsSchema.parse(options);
      const limit = valid.limit ?? DEFAULT_RECENT_LIMIT;
      const result =
        valid.actionName !== undefined
          ? await pool.query(
              `SELECT ${SELECT_RUN_COLUMNS}
               FROM live_action_runs
               WHERE action_name = $1
               ORDER BY started_at DESC, id DESC
               LIMIT $2`,
              [valid.actionName, limit],
            )
          : await pool.query(
              `SELECT ${SELECT_RUN_COLUMNS}
               FROM live_action_runs
               ORDER BY started_at DESC, id DESC
               LIMIT $1`,
              [limit],
            );
      return result.rows.map(mapLiveActionRunRow);
    },
  };
}
