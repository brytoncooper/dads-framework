import type { PostgresQuery, PostgresRow } from "./postgres-types.js";

// Include installation, server incarnation, database, role and physical table
// identity so an executor cannot accidentally reuse a stamp across authorities.
function revisionQuery(namespace: string): string {
  return `SELECT pg_catalog.json_build_array(
    epoch.installation, epoch.revision, COALESCE(revision.revision, 0),
    pg_catalog.pg_postmaster_start_time(), current_database(),
    pg_catalog.inet_server_addr(), pg_catalog.inet_server_port(), current_user,
    relation.oid, pg_catalog.pg_relation_filenode(relation.oid)
  )::text AS stamp
  FROM dad_lookup_revision.epoch epoch
  LEFT JOIN dad_lookup_revision.namespace revision ON revision.namespace = ${namespace}
  JOIN pg_catalog.pg_class relation ON relation.oid = 'public.dad_authorization_relationship'::regclass
  WHERE epoch.singleton
    AND NOT pg_catalog.pg_is_in_recovery()
    AND pg_catalog.pg_current_xact_id_if_assigned() IS NULL
    AND pg_catalog.to_regclass('dad_authorization_relationship') = relation.oid
    AND relation.relkind = 'r' AND relation.relpersistence = 'p'
    AND NOT relation.relhassubclass AND NOT relation.relrowsecurity
    AND NOT pg_catalog.pg_has_role(current_user, relation.relowner, 'MEMBER')
    AND pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
    AND NOT pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
    AND NOT pg_catalog.has_schema_privilege(current_user, 'dad_lookup_revision', 'CREATE')
    AND NOT pg_catalog.has_table_privilege(current_user, 'dad_lookup_revision.epoch', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND NOT pg_catalog.has_table_privilege(current_user, 'dad_lookup_revision.namespace', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND NOT pg_catalog.has_sequence_privilege(current_user, 'dad_lookup_revision.token', 'USAGE,UPDATE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class metadata
      WHERE metadata.oid IN (
        'dad_lookup_revision.epoch'::regclass, 'dad_lookup_revision.namespace'::regclass,
        'dad_lookup_revision.token'::regclass
      ) AND pg_catalog.pg_has_role(current_user, metadata.relowner, 'MEMBER')
    )
    AND 4 = (
      SELECT count(*) FROM pg_catalog.pg_trigger trigger
      WHERE trigger.tgrelid = relation.oid AND trigger.tgenabled = 'A'
        AND trigger.tgfoid = 'dad_lookup_revision.mark()'::regprocedure
        AND trigger.tgname IN ('dad_lookup_revision_insert', 'dad_lookup_revision_delete',
          'dad_lookup_revision_update', 'dad_lookup_revision_truncate')
    )`;
}

export function lookupRevisionQuery(namespace: string): PostgresQuery {
  return { text: revisionQuery("$1"), values: [namespace] };
}

/** The revision and ordered result must use the exact same database snapshot. */
export function lookupWithRevision(query: PostgresQuery, namespace: string): PostgresQuery {
  const values = query.values ?? [];
  return {
    text: `SELECT revision.stamp,
      pg_catalog.array_to_json(ARRAY(
        SELECT result.resource_id FROM (${query.text}) result
        ORDER BY result.resource_id
      ))::text AS resource_ids
      FROM (${revisionQuery(`$${String(values.length + 1)}`)}) revision`,
    values: [...values, namespace],
  };
}

export function readLookupRevision(row: PostgresRow | undefined): string {
  const stamp = row?.["stamp"];
  if (typeof stamp !== "string")
    throw new Error("Postgres lookup reuse requires the versioned primary and restricted runtime role");
  return stamp;
}

export function readRevisionedIds(row: PostgresRow | undefined): readonly string[] {
  const text = row?.["resource_ids"];
  if (typeof text !== "string") throw new Error("Postgres authorization returned invalid resource IDs");
  const ids: unknown = JSON.parse(text);
  if (!Array.isArray(ids) || !ids.every((id: unknown): id is string => typeof id === "string"))
    throw new Error("Postgres authorization returned invalid resource IDs");
  return Object.freeze(ids);
}
