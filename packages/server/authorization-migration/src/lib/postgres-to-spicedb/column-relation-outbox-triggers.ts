import {
  emitAccessIr,
  type AccessIrDefinition,
  type AccessModel,
  type RoleToken,
} from "@dads-framework/access";

const SQL_COLUMN_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SQL_TABLE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
const DEFAULT_OUTBOX_TABLE = "authorization_outbox";

/**
 * Structurally identical to `ColumnRelationBinding` in `@dads-framework/postgres-access`
 * so applications can pass the exact same bindings array into the SpiceDB exporter.
 */
export type PostgresColumnRelationExportBinding = {
  readonly role: RoleToken;
  /** Table name (`documents` or `app.documents`). */
  readonly table: string;
  /** Primary key column storing the resource ID (e.g. `"id"`). */
  readonly idColumn: string;
  /** Foreign-key column storing the target ID (e.g. `"org_id"`, `"parent_id"`, `"owner_id"`). */
  readonly targetIdColumn: string;
};

export type ResolvedExportColumnRelation = {
  readonly entity: string;
  readonly relation: string;
  readonly targetEntity: string;
  readonly table: string;
  readonly idColumn: string;
  readonly targetIdColumn: string;
};

export type ColumnRelationOutboxTriggerOptions = {
  /** Target outbox table name (defaults to `"authorization_outbox"`). */
  readonly outboxTable?: string;
};

export type ColumnRelationOutboxTriggerDdl = {
  /** Idempotent SQL statements creating functions and triggers for every binding. */
  readonly up: readonly string[];
  /** Idempotent SQL statements dropping the triggers and functions. */
  readonly down: readonly string[];
};

function assertIdentifier(
  value: string,
  pattern: RegExp,
  label: string,
): string {
  if (!pattern.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": must be an unquoted SQL identifier`,
    );
  }
  return value;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sanitizeTriggerSlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

/** Validate `columnRelations` bindings against `AccessModel` and resolve each target entity. */
export function resolveExportColumnRelations(
  model: AccessModel,
  bindings: readonly PostgresColumnRelationExportBinding[] | undefined,
): readonly ResolvedExportColumnRelation[] {
  if (bindings === undefined || bindings.length === 0) return [];
  const definitions = emitAccessIr(model);
  const byEntity = new Map(definitions.map((entry) => [entry.wireName, entry]));
  const seen = new Set<string>();
  return Object.freeze(
    bindings.map((binding) => resolveOneBinding(byEntity, binding, seen)),
  );
}

function resolveOneBinding(
  byEntity: ReadonlyMap<string, AccessIrDefinition>,
  binding: PostgresColumnRelationExportBinding,
  seen: Set<string>,
): ResolvedExportColumnRelation {
  const entity = binding.role.entityWireName;
  const relation = binding.role.roleName;
  const key = `${entity}\u0000${relation}`;
  if (seen.has(key)) {
    throw new Error(
      `Duplicate columnRelation binding for ${entity}#${relation}`,
    );
  }
  seen.add(key);

  const table = assertIdentifier(binding.table, SQL_TABLE_IDENT, "table");
  const idColumn = assertIdentifier(
    binding.idColumn,
    SQL_COLUMN_IDENT,
    "idColumn",
  );
  const targetIdColumn = assertIdentifier(
    binding.targetIdColumn,
    SQL_COLUMN_IDENT,
    "targetIdColumn",
  );

  const def = byEntity.get(entity);
  const roleDef = def?.roles.find((candidate) => candidate.name === relation);
  if (roleDef === undefined) {
    throw new Error(
      `Column relation ${entity}#${relation} does not exist in the access model`,
    );
  }
  const onlySubject =
    roleDef.subjects.length === 1 ? roleDef.subjects[0] : undefined;
  if (onlySubject === undefined || onlySubject.kind !== "type") {
    throw new Error(
      `Column relation ${entity}#${relation} must declare exactly one direct entity target`,
    );
  }
  return Object.freeze({
    entity,
    relation,
    targetEntity: onlySubject.wireName,
    table,
    idColumn,
    targetIdColumn,
  });
}

/**
 * Generate idempotent PostgreSQL triggers that automatically enqueue `WRITE` /
 * `DELETE` entries into `authorization_outbox` whenever a `columnRelations`
 * foreign-key column is inserted, updated, or deleted.
 *
 * Install these triggers right before running `migratePostgresToSpiceDb` so
 * existing app SQL keeps working with zero code changes during a cutover to
 * SpiceDB.
 */
export function columnRelationOutboxTriggerSql(
  model: AccessModel,
  bindings: readonly PostgresColumnRelationExportBinding[],
  options?: ColumnRelationOutboxTriggerOptions,
): ColumnRelationOutboxTriggerDdl {
  const outboxTable = assertIdentifier(
    options?.outboxTable ?? DEFAULT_OUTBOX_TABLE,
    SQL_TABLE_IDENT,
    "outboxTable",
  );
  const resolved = resolveExportColumnRelations(model, bindings);
  const up: string[] = [];
  const down: string[] = [];

  for (const binding of resolved) {
    const slug = sanitizeTriggerSlug(
      `${binding.table}_${binding.targetIdColumn}_${binding.relation}`,
    );
    const fnName = `dad_outbox_colrel_${slug}`;
    const trigName = `trg_dad_outbox_${slug}`;
    up.push(buildTriggerFunctionSql(fnName, outboxTable, binding));
    up.push(
      `DROP TRIGGER IF EXISTS ${trigName} ON ${binding.table};
CREATE TRIGGER ${trigName}
  AFTER INSERT OR UPDATE OR DELETE ON ${binding.table}
  FOR EACH ROW EXECUTE FUNCTION ${fnName}();`,
    );
    down.push(`DROP TRIGGER IF EXISTS ${trigName} ON ${binding.table};`);
    down.push(`DROP FUNCTION IF EXISTS ${fnName}();`);
  }

  return Object.freeze({ up: Object.freeze(up), down: Object.freeze(down) });
}

function buildTriggerFunctionSql(
  fnName: string,
  outboxTable: string,
  binding: ResolvedExportColumnRelation,
): string {
  const entityLit = sqlLiteral(binding.entity);
  const relationLit = sqlLiteral(binding.relation);
  const targetLit = sqlLiteral(binding.targetEntity);
  const idCol = binding.idColumn;
  const targetCol = binding.targetIdColumn;
  return `CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.${targetCol} IS NOT NULL THEN
      INSERT INTO ${outboxTable} (
        idempotency_key, operation, resource_type, resource_id, relation,
        subject_type, subject_id, subject_relation, owner_partition_id, status, enqueued_at
      ) VALUES (
        'colrel:del:' || gen_random_uuid()::text, 'DELETE', ${entityLit}, OLD.${idCol}::text, ${relationLit},
        ${targetLit}, OLD.${targetCol}::text, NULL, NULL, 'PENDING', clock_timestamp()
      );
    END IF;
    RETURN OLD;
  ELSIF (TG_OP = 'INSERT') THEN
    IF NEW.${targetCol} IS NOT NULL THEN
      INSERT INTO ${outboxTable} (
        idempotency_key, operation, resource_type, resource_id, relation,
        subject_type, subject_id, subject_relation, owner_partition_id, status, enqueued_at
      ) VALUES (
        'colrel:write:' || gen_random_uuid()::text, 'WRITE', ${entityLit}, NEW.${idCol}::text, ${relationLit},
        ${targetLit}, NEW.${targetCol}::text, NULL, NULL, 'PENDING', clock_timestamp()
      );
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (OLD.${idCol} IS DISTINCT FROM NEW.${idCol}) OR (OLD.${targetCol} IS DISTINCT FROM NEW.${targetCol}) THEN
      IF OLD.${targetCol} IS NOT NULL THEN
        INSERT INTO ${outboxTable} (
          idempotency_key, operation, resource_type, resource_id, relation,
          subject_type, subject_id, subject_relation, owner_partition_id, status, enqueued_at
        ) VALUES (
          'colrel:del:' || gen_random_uuid()::text, 'DELETE', ${entityLit}, OLD.${idCol}::text, ${relationLit},
          ${targetLit}, OLD.${targetCol}::text, NULL, NULL, 'PENDING', clock_timestamp()
        );
      END IF;
      IF NEW.${targetCol} IS NOT NULL THEN
        INSERT INTO ${outboxTable} (
          idempotency_key, operation, resource_type, resource_id, relation,
          subject_type, subject_id, subject_relation, owner_partition_id, status, enqueued_at
        ) VALUES (
          'colrel:write:' || gen_random_uuid()::text, 'WRITE', ${entityLit}, NEW.${idCol}::text, ${relationLit},
          ${targetLit}, NEW.${targetCol}::text, NULL, NULL, 'PENDING', clock_timestamp()
        );
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;`;
}
