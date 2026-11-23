import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { LiveActionRedactedInput, LiveActionRunOutcome } from "./live-action-run-types.js";

/** Drizzle table definition matching `liveActionRunsMigration`. */
export const liveActionRunsTable = pgTable(
  "live_action_runs",
  {
    id: uuid("id").primaryKey().notNull(),
    actionName: text("action_name").notNull(),
    dangerLevel: text("danger_level").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    redactedInput: jsonb("redacted_input").$type<LiveActionRedactedInput>().notNull(),
    outcome: text("outcome").notNull().$type<LiveActionRunOutcome>(),
    summary: text("summary"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("live_action_runs_started_at_idx").on(table.startedAt),
    index("live_action_runs_action_started_at_idx").on(table.actionName, table.startedAt),
  ],
);
