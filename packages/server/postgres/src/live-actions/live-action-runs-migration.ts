import type { LiveActionQueryClient } from "./live-action-run-types.js";

/**
 * Idempotent DDL creating the `live_action_runs` audit table and its lookup
 * indexes. Safe to run repeatedly on startup or from a migration script.
 */
export const liveActionRunsMigration = `
CREATE TABLE IF NOT EXISTS live_action_runs (
  id uuid PRIMARY KEY,
  action_name text NOT NULL,
  danger_level text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  redacted_input jsonb NOT NULL,
  outcome text NOT NULL,
  summary text,
  error_message text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS live_action_runs_started_at_idx
  ON live_action_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS live_action_runs_action_started_at_idx
  ON live_action_runs (action_name, started_at DESC);
`.trim();

/** Applies the idempotent `live_action_runs` table migration against `client`. */
export async function applyLiveActionRunsMigration(client: LiveActionQueryClient): Promise<void> {
  await client.query(liveActionRunsMigration);
}
