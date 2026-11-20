import type { MigrationBuilder } from "node-pg-migrate";

/** The complete audit schema for a new database. Applications attach their own table triggers. */
export function up(pgm: MigrationBuilder): void {
  createAuditLogTable(pgm);
  pgm.sql(AUDIT_LOG_IMMUTABLE_SQL);
  pgm.sql(AUDIT_RECORD_FUNCTION_SQL);
  createRequestLog(pgm);
  createClientDiagnostics(pgm);
  createKnownFaults(pgm);
}

export const down = false;

function createAuditLogTable(pgm: MigrationBuilder): void {
  pgm.createTable("audit_log", {
    position: {
      type: "bigint",
      primaryKey: true,
      sequenceGenerated: { precedence: "ALWAYS" },
    },
    transaction_id: {
      type: "xid8",
      notNull: true,
      default: pgm.func("pg_current_xact_id()"),
    },
    recorded_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    actor_kind: { type: "text", notNull: true },
    actor_id: { type: "text", notNull: true },
    request_id: { type: "text", notNull: true },
    reason: { type: "text" },
    owner_partition_id: { type: "uuid" },
    table_name: { type: "text", notNull: true },
    scope_values: { type: "jsonb" },
    row_key: { type: "jsonb", notNull: true },
    user_id: { type: "text" },
    client_id: { type: "text" },
    client_name: { type: "text" },
    operation: { type: "text", notNull: true },
    changed_columns: { type: "text[]" },
    row_before: { type: "jsonb" },
    row_after: { type: "jsonb" },
  });

  pgm.addConstraint(
    "audit_log",
    "audit_log_operation_check",
    "CHECK (operation IN ('insert', 'update', 'delete'))",
  );
  pgm.sql(AUDIT_LOG_INDEXES_SQL);
}

const AUDIT_LOG_IMMUTABLE_SQL = `
CREATE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
`;

const AUDIT_LOG_INDEXES_SQL = `
CREATE INDEX audit_log_actor_position_idx ON audit_log (actor_kind, actor_id, position);
CREATE INDEX audit_log_partition_position_idx ON audit_log (owner_partition_id, position);
CREATE INDEX audit_log_request_idx ON audit_log (request_id);
CREATE INDEX audit_log_row_time_idx ON audit_log (table_name, row_key, recorded_at DESC, position DESC);
CREATE INDEX audit_log_table_position_idx ON audit_log (table_name, position);
CREATE INDEX audit_log_time_idx ON audit_log (recorded_at DESC, position DESC);
CREATE INDEX audit_log_user_time_idx ON audit_log (user_id, recorded_at DESC, position DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX audit_log_scope_table_idx
  ON audit_log USING gin (scope_values jsonb_path_ops, (ARRAY[table_name]));
`;

const AUDIT_RECORD_FUNCTION_SQL = `
CREATE FUNCTION public.audit_record() RETURNS trigger
LANGUAGE plpgsql AS $$
-- Arguments name key columns, an optional UUID owner column, and a scope map.
DECLARE
  actor_setting text;
  actor jsonb;
  before_row jsonb;
  after_row jsonb;
  subject jsonb;
  key_values jsonb;
  changed text[];
  owner_id uuid;
  acting_user_id text;
  scope_values jsonb;
BEGIN
  actor_setting := nullif(current_setting('dads.audit_actor', true), '');
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION 'Audit actor is required for %', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  actor := actor_setting::jsonb;
  IF nullif(actor ->> 'kind', '') IS NULL
    OR nullif(actor ->> 'requestId', '') IS NULL
    OR actor ->> 'id' IS NULL THEN
    RAISE EXCEPTION 'Audit actor identity is incomplete for %', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    after_row := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    before_row := to_jsonb(OLD);
    after_row := to_jsonb(NEW);
  ELSE
    before_row := to_jsonb(OLD);
  END IF;

  subject := coalesce(after_row, before_row);

  IF TG_ARGV[0] = '' THEN
    key_values := '{}'::jsonb;
  ELSE
    SELECT coalesce(jsonb_object_agg(key_column, subject -> key_column), '{}'::jsonb)
      INTO key_values
      FROM unnest(string_to_array(TG_ARGV[0], ',')) AS key_column;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(changes.key ORDER BY changes.key)
      INTO changed
      FROM jsonb_each(after_row) AS changes
      WHERE before_row -> changes.key IS DISTINCT FROM changes.value;
  END IF;

  IF TG_ARGV[1] <> '' THEN
    owner_id := (subject ->> TG_ARGV[1])::uuid;
  END IF;

  SELECT jsonb_object_agg(scope.dimension, subject ->> scope.column_name)
    INTO scope_values
    FROM jsonb_each_text(coalesce(TG_ARGV[2]::jsonb, '{}'::jsonb))
      AS scope(dimension, column_name)
    WHERE subject ->> scope.column_name IS NOT NULL
      AND (
        TG_OP <> 'UPDATE'
        OR before_row -> scope.column_name IS NOT DISTINCT FROM after_row -> scope.column_name
      );

  IF actor ->> 'kind' = 'user' THEN
    acting_user_id := nullif(actor ->> 'id', '');
  END IF;

  INSERT INTO public.audit_log (
    actor_kind,
    actor_id,
    request_id,
    reason,
    owner_partition_id,
    scope_values,
    user_id,
    client_id,
    client_name,
    table_name,
    row_key,
    operation,
    changed_columns,
    row_before,
    row_after
  ) VALUES (
    actor ->> 'kind',
    actor ->> 'id',
    actor ->> 'requestId',
    actor ->> 'reason',
    owner_id,
    scope_values,
    acting_user_id,
    nullif(actor ->> 'clientId', ''),
    nullif(actor ->> 'clientName', ''),
    TG_TABLE_NAME,
    key_values,
    lower(TG_OP),
    changed,
    before_row,
    after_row
  );

  RETURN NULL;
END;
$$;
`;

function createRequestLog(pgm: MigrationBuilder): void {
  pgm.createTable("request_log", {
    request_id: { type: "text", primaryKey: true },
    recorded_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    method: { type: "text", notNull: true },
    route_id: { type: "text" },
    path: { type: "text", notNull: true },
    status: { type: "integer", notNull: true },
    duration_ms: { type: "integer", notNull: true },
    actor_kind: { type: "text", notNull: true },
    actor_id: { type: "text", notNull: true },
    auth_method: { type: "text" },
    access_kind: { type: "text" },
    permission: { type: "text" },
    resource_type: { type: "text" },
    resource_id: { type: "text" },
    decision: { type: "text", notNull: true },
    error_code: { type: "text" },
    ip: { type: "inet" },
    forwarded_for: { type: "text" },
    user_agent: { type: "text" },
    client_hints: { type: "jsonb" },
    accept_language: { type: "text" },
    client_context: { type: "jsonb" },
    api_release: { type: "text" },
    db_query_count: { type: "integer" },
    db_ms: { type: "integer" },
    authz_check_count: { type: "integer" },
    authz_ms: { type: "integer" },
    instance_id: { type: "text" },
    authz_cached_read_count: { type: "integer" },
    authz_fully_consistent_read_count: { type: "integer" },
    authz_largest_lookup_count: { type: "integer" },
    exception_type: { type: "text" },
    exception_fingerprint: { type: "text" },
    trace_id: { type: "text" },
    imported: { type: "boolean", notNull: true, default: false },
  });

  pgm.addConstraint(
    "request_log",
    "request_log_decision_check",
    "CHECK (decision IN ('allow', 'denied', 'not-found', 'unauthenticated', 'error'))",
  );

  pgm.createIndex("request_log", ["recorded_at"], {
    name: "request_log_recorded_at_idx",
  });
  pgm.createIndex("request_log", ["actor_kind", "actor_id", "recorded_at"], {
    name: "request_log_actor_recorded_at_idx",
  });
  pgm.createIndex("request_log", ["status", "recorded_at"], {
    name: "request_log_status_recorded_at_idx",
  });

  pgm.createIndex("request_log", ["route_id", "recorded_at"], {
    name: "request_log_route_recorded_at_idx",
  });
  pgm.createIndex("request_log", ["exception_fingerprint", "recorded_at"], {
    name: "request_log_exception_recorded_at_idx",
  });
}

function createClientDiagnostics(pgm: MigrationBuilder): void {
  pgm.createTable("client_diagnostic_events", {
    id: { type: "uuid", primaryKey: true },
    recorded_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },

    occurred_at: { type: "timestamptz", notNull: true },
    fingerprint: { type: "text", notNull: true },
    kind: { type: "text", notNull: true },
    severity: { type: "text", notNull: true },
    name: { type: "text", notNull: true },
    message: { type: "text", notNull: true },
    frames: { type: "jsonb", notNull: true },
    breadcrumbs: { type: "jsonb", notNull: true },
    release: { type: "text", notNull: true },
    client: { type: "text", notNull: true },

    request_id: { type: "text" },

    actor_kind: { type: "text", notNull: true },
    actor_id: { type: "text", notNull: true },
    context: { type: "jsonb" },
  });

  pgm.addConstraint(
    "client_diagnostic_events",
    "client_diagnostic_events_severity_check",
    "CHECK (severity IN ('error', 'warning', 'info'))",
  );
  pgm.createIndex("client_diagnostic_events", ["fingerprint", "recorded_at"], {
    name: "client_diagnostic_events_fingerprint_recorded_at_idx",
  });
  pgm.createIndex("client_diagnostic_events", ["recorded_at"], {
    name: "client_diagnostic_events_recorded_at_idx",
  });
  pgm.createIndex("client_diagnostic_events", ["release", "recorded_at"], {
    name: "client_diagnostic_events_release_recorded_at_idx",
  });
  pgm.createIndex("client_diagnostic_events", ["request_id"], {
    name: "client_diagnostic_events_request_idx",
  });

  pgm.sql(`
    COMMENT ON COLUMN client_diagnostic_events.message IS
      'The exception''s own text. Free text a page may have composed from user input, bounded by the contract on the way in and by the retention sweep on the way out — the same bound request_log puts on an address.';
  `);
  pgm.sql(`
    COMMENT ON COLUMN client_diagnostic_events.occurred_at IS
      'The CLIENT''s clock at the moment of the fault, not the server''s. Untrusted: compare against recorded_at rather than ordering by it.';
  `);
}

function createKnownFaults(pgm: MigrationBuilder): void {
  pgm.createTable("known_fault_fingerprints", {
    origin: { type: "text", notNull: true },
    fingerprint: { type: "text", notNull: true },
    first_alerted_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint(
    "known_fault_fingerprints",
    "known_fault_fingerprints_pkey",
    { primaryKey: ["origin", "fingerprint"] },
  );

  pgm.addConstraint(
    "known_fault_fingerprints",
    "known_fault_fingerprints_origin_check",
    "CHECK (origin IN ('server', 'client'))",
  );

  pgm.sql(`
    COMMENT ON TABLE known_fault_fingerprints IS
      'Fault types that have already been alerted on. Never pruned: it is what lets the sweep say "new" truthfully after the fault tables it watches have aged their rows out.';
  `);
}
