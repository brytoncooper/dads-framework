import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.createTable("authorization_outbox", {
    id: {
      type: "uuid",
      primaryKey: true,
      notNull: true,
      default: pgm.func("gen_random_uuid()"),
    },
    idempotency_key: { type: "text", notNull: true },
    operation: { type: "text", notNull: true },
    resource_type: { type: "text", notNull: true },
    resource_id: { type: "text", notNull: true },
    relation: { type: "text", notNull: true },
    subject_type: { type: "text", notNull: true },
    subject_id: { type: "text", notNull: true },
    subject_relation: { type: "text" },
    owner_partition_id: { type: "uuid" },
    status: { type: "text", notNull: true },
    attempts: { type: "integer", notNull: true, default: 0 },
    locked_by: { type: "text" },
    locked_at: { type: "timestamptz" },
    last_error: { type: "text" },
    enqueued_at: { type: "timestamptz", notNull: true },
    projected_at: { type: "timestamptz" },
    superseded_at: { type: "timestamptz" },
    superseded_by_idempotency_key: { type: "text" },
  });
  pgm.addConstraint(
    "authorization_outbox",
    "authorization_outbox_supersession_check",
    "CHECK ((((status = 'SUPERSEDED'::text) AND (superseded_at IS NOT NULL) AND (superseded_by_idempotency_key IS NOT NULL) AND (last_error IS NULL)) OR ((status <> 'SUPERSEDED'::text) AND (superseded_at IS NULL) AND (superseded_by_idempotency_key IS NULL))))",
  );
  pgm.createIndex("authorization_outbox", ["idempotency_key"], {
    name: "authorization_outbox_idempotency_uidx",
    unique: true,
  });
  pgm.createIndex("authorization_outbox", ["owner_partition_id"], {
    name: "authorization_outbox_partition_idx",
  });
  pgm.createIndex("authorization_outbox", ["status", "enqueued_at"], {
    name: "authorization_outbox_status_enqueued_idx",
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("authorization_outbox");
}
