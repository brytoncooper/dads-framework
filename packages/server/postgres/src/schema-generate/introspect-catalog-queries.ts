/** SQL catalog queries used by `introspectPostgresCatalog`. */

export const SELECT_FILTERED_SCHEMAS_SQL = `
  SELECT nspname AS schema_name
  FROM pg_catalog.pg_namespace
  WHERE nspname = ANY($1::text[])
  ORDER BY nspname
`;

export const SELECT_USER_SCHEMAS_SQL = `
  SELECT nspname AS schema_name
  FROM pg_catalog.pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'dads_migration')
    AND left(nspname, 3) <> 'pg_'
  ORDER BY nspname
`;

export const SELECT_ENUMS_SQL = `
  SELECT
    n.nspname AS schema_name,
    t.typname AS enum_name,
    ARRAY(
      SELECT e.enumlabel
      FROM pg_catalog.pg_enum e
      WHERE e.enumtypid = t.oid
      ORDER BY e.enumsortorder
    ) AS labels
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = ANY($1::text[])
    AND t.typtype = 'e'
  ORDER BY n.nspname, t.typname
`;

export const SELECT_TABLES_SQL = `
  SELECT n.nspname AS schema_name, c.relname AS table_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND c.relkind IN ('r', 'p')
    AND NOT (c.relname = ANY($2::text[]))
  ORDER BY n.nspname, c.relname
`;

export const SELECT_COLUMNS_SQL = `
  SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    a.attname AS column_name,
    a.attnum::int AS ordinal,
    format_type(a.atttypid, a.atttypmod) AS formatted_type,
    tn.nspname AS udt_schema,
    t.typname AS udt_name,
    NOT a.attnotnull AS is_nullable,
    CASE WHEN a.attgenerated = '' THEN pg_get_expr(ad.adbin, ad.adrelid) ELSE NULL END AS default_expression,
    a.attidentity::text AS identity_generation,
    a.attgenerated::text AS generated_kind,
    CASE WHEN a.attgenerated <> '' THEN pg_get_expr(ad.adbin, ad.adrelid) ELSE NULL END AS generated_expression,
    a.attndims::int AS array_dimensions
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = ANY($1::text[])
    AND c.relkind IN ('r', 'p')
    AND NOT (c.relname = ANY($2::text[]))
    AND a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY n.nspname, c.relname, a.attnum
`;

export const SELECT_CONSTRAINTS_SQL = `
  SELECT
    n.nspname AS schema_name,
    rel.relname AS table_name,
    con.conname AS constraint_name,
    con.contype::text AS constraint_type,
    pg_get_constraintdef(con.oid, true) AS definition,
    COALESCE(
      ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      ),
      ARRAY[]::text[]
    ) AS columns,
    fn.nspname AS referenced_schema,
    frel.relname AS referenced_table,
    COALESCE(
      ARRAY(
        SELECT fa.attname
        FROM unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord)
        JOIN pg_catalog.pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = fk.attnum
        ORDER BY fk.ord
      ),
      ARRAY[]::text[]
    ) AS referenced_columns,
    con.confupdtype::text AS on_update,
    con.confdeltype::text AS on_delete
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
  LEFT JOIN pg_catalog.pg_class frel ON frel.oid = con.confrelid
  LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = frel.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND rel.relkind IN ('r', 'p')
    AND NOT (rel.relname = ANY($2::text[]))
    AND con.contype IN ('p', 'f', 'u', 'c')
  ORDER BY n.nspname, rel.relname, con.conname
`;

export const SELECT_INDEXES_SQL = `
  SELECT
    n.nspname AS schema_name,
    t.relname AS table_name,
    i.relname AS index_name,
    ix.indisunique AS is_unique,
    ix.indisprimary AS is_primary,
    am.amname AS access_method,
    pg_get_indexdef(ix.indexrelid) AS definition,
    COALESCE(
      ARRAY(
        SELECT CASE WHEN key_col.attnum > 0 THEN a.attname ELSE '' END
        FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS key_col(attnum, ord)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = key_col.attnum
        WHERE key_col.ord <= ix.indnkeyatts
        ORDER BY key_col.ord
      ),
      ARRAY[]::text[]
    ) AS key_columns,
    COALESCE(
      ARRAY(
        SELECT pg_get_indexdef(ix.indexrelid, pos, true)
        FROM generate_series(1, ix.indnkeyatts) AS pos
      ),
      ARRAY[]::text[]
    ) AS key_expressions,
    pg_get_expr(ix.indpred, ix.indrelid) AS where_predicate
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_am am ON am.oid = i.relam
  WHERE n.nspname = ANY($1::text[])
    AND t.relkind IN ('r', 'p')
    AND NOT (t.relname = ANY($2::text[]))
  ORDER BY n.nspname, t.relname, i.relname
`;

export const SELECT_TRIGGERS_SQL = `
  SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    tg.tgname AS trigger_name,
    pg_get_triggerdef(tg.oid) AS definition,
    tg.tgisinternal AS is_internal
  FROM pg_catalog.pg_trigger tg
  JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND c.relkind IN ('r', 'p')
    AND NOT (c.relname = ANY($2::text[]))
    AND NOT tg.tgisinternal
  ORDER BY n.nspname, c.relname, tg.tgname
`;
