import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  FEATURE_FLAG_AUDIENCE_MODES,
  type FeatureFlagState,
} from "@dads-framework/feature-flags";

/**
 * Drizzle's view of the tables `20261119180000_feature_flags.migration.ts`
 * creates. The migration is the source of truth; these describe it.
 */

/** One row per flag that has ever been changed. `row_version` is the wire's `revision`. */
export const featureFlagStates = pgTable(
  "feature_flag_states",
  {
    id: uuid("id").primaryKey().notNull(),
    slug: text("slug").notNull(),
    audienceMode: text("audience_mode", {
      enum: FEATURE_FLAG_AUDIENCE_MODES,
    }).notNull(),
    globalEnabledAt: timestamp("global_enabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by").notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    uniqueIndex("feature_flag_states_slug_uidx").on(table.slug),
    check(
      "feature_flag_states_mode_timer_chk",
      sql`(${table.audienceMode} = 'EVERYONE' AND ${table.globalEnabledAt} IS NOT NULL) OR (${table.audienceMode} <> 'EVERYONE' AND ${table.globalEnabledAt} IS NULL)`,
    ),
  ],
);

/** A remembered pilot tenant of one flag; `enabled_at` is null while it is not selected. */
export const featureFlagTenantTargets = pgTable(
  "feature_flag_tenant_targets",
  {
    id: uuid("id").primaryKey().notNull(),
    featureFlagStateId: uuid("feature_flag_state_id")
      .notNull()
      .references(() => featureFlagStates.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    tenantName: text("tenant_name").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("feature_flag_tenant_targets_state_tenant_uidx").on(
      table.featureFlagStateId,
      table.tenantId,
    ),
    index("feature_flag_tenant_targets_tenant_enabled_idx").on(
      table.tenantId,
      table.enabledAt,
    ),
  ],
);

/** Before and after snapshots of every revision. Code only ever inserts here. */
export const featureFlagChangeEvents = pgTable(
  "feature_flag_change_events",
  {
    id: uuid("id").primaryKey().notNull(),
    batchId: uuid("batch_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    previousState: jsonb("previous_state").notNull().$type<FeatureFlagState>(),
    nextState: jsonb("next_state").notNull().$type<FeatureFlagState>(),
    note: text("note"),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    changedBy: text("changed_by").notNull(),
  },
  (table) => [
    index("feature_flag_change_events_slug_revision_idx").on(
      table.slug,
      table.revision,
    ),
    index("feature_flag_change_events_batch_idx").on(table.batchId),
  ],
);
