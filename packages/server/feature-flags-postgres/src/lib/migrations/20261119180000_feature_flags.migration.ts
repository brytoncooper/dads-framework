import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Feature-flag audience state, its pilot tenants and its change history.
 * Definitions are code and are never stored. Tenant and actor ids are text:
 * the application decides what they are.
 */
export function up(pgm: MigrationBuilder): void {
  createStates(pgm);
  createTenantTargets(pgm);
  createChangeEvents(pgm);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("feature_flag_change_events");
  pgm.dropTable("feature_flag_tenant_targets");
  pgm.dropTable("feature_flag_states");
}

function createStates(pgm: MigrationBuilder): void {
  pgm.createTable("feature_flag_states", {
    id: { type: "uuid", primaryKey: true, notNull: true },
    slug: { type: "text", notNull: true },
    audience_mode: { type: "text", notNull: true },
    global_enabled_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_by: { type: "text", notNull: true },
    // The wire's `revision`: every write checks the one it expects.
    row_version: { type: "integer", notNull: true, default: 1 },
  });
  pgm.addConstraint("feature_flag_states", "feature_flag_states_mode_chk", {
    check: "audience_mode IN ('OFF', 'SELECTED_TENANTS', 'EVERYONE')",
  });
  pgm.addConstraint(
    "feature_flag_states",
    "feature_flag_states_mode_timer_chk",
    {
      check:
        "(audience_mode = 'EVERYONE' AND global_enabled_at IS NOT NULL) OR (audience_mode <> 'EVERYONE' AND global_enabled_at IS NULL)",
    },
  );
  pgm.addConstraint(
    "feature_flag_states",
    "feature_flag_states_row_version_chk",
    { check: "row_version > 0" },
  );
  pgm.createIndex("feature_flag_states", "slug", {
    name: "feature_flag_states_slug_uidx",
    unique: true,
  });
}

function createTenantTargets(pgm: MigrationBuilder): void {
  pgm.createTable("feature_flag_tenant_targets", {
    id: { type: "uuid", primaryKey: true, notNull: true },
    feature_flag_state_id: {
      type: "uuid",
      notNull: true,
      references: "feature_flag_states",
      onDelete: "CASCADE",
    },
    tenant_id: { type: "text", notNull: true },
    tenant_name: { type: "text", notNull: true },
    enabled_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.createIndex(
    "feature_flag_tenant_targets",
    ["feature_flag_state_id", "tenant_id"],
    { name: "feature_flag_tenant_targets_state_tenant_uidx", unique: true },
  );
  pgm.createIndex("feature_flag_tenant_targets", ["tenant_id", "enabled_at"], {
    name: "feature_flag_tenant_targets_tenant_enabled_idx",
  });
}

function createChangeEvents(pgm: MigrationBuilder): void {
  pgm.createTable("feature_flag_change_events", {
    id: { type: "uuid", primaryKey: true, notNull: true },
    batch_id: { type: "uuid", notNull: true },
    slug: { type: "text", notNull: true },
    revision: { type: "integer", notNull: true },
    previous_state: { type: "jsonb", notNull: true },
    next_state: { type: "jsonb", notNull: true },
    note: { type: "text" },
    changed_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    changed_by: { type: "text", notNull: true },
  });
  pgm.createIndex("feature_flag_change_events", ["slug", "revision"], {
    name: "feature_flag_change_events_slug_revision_idx",
  });
  pgm.createIndex("feature_flag_change_events", "batch_id", {
    name: "feature_flag_change_events_batch_idx",
  });
}
