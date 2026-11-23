import type { PostgresClient as Client } from "../../index.js";

export async function publicSchemaFingerprint(client: Client): Promise<string> {
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    formatted_type: string;
    nullable: boolean;
    column_default: string | null;
  }>(`
    SELECT
      c.relname AS table_name,
      a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS formatted_type,
      NOT a.attnotnull AS nullable,
      pg_get_expr(ad.adbin, ad.adrelid) AS column_default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p')
      AND n.nspname = 'public'
    ORDER BY c.relname, a.attnum
  `);
  const indexes = await client.query<{
    table_name: string;
    index_name: string;
    is_unique: boolean;
    index_def: string;
  }>(`
    SELECT
      t.relname AS table_name,
      i.relname AS index_name,
      ix.indisunique AS is_unique,
      pg_get_indexdef(ix.indexrelid) AS index_def
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.relname, i.relname
  `);
  const constraints = await client.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>(`
    SELECT
      rel.relname AS table_name,
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND con.contype IN ('c', 'f', 'p', 'u')
    ORDER BY rel.relname, con.conname
  `);
  const enums = await client.query<{ type_name: string; labels: string[] }>(`
    SELECT
      t.typname AS type_name,
      ARRAY(
        SELECT e.enumlabel
        FROM pg_enum e
        WHERE e.enumtypid = t.oid
        ORDER BY e.enumsortorder
      ) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
    ORDER BY t.typname
  `);

  return JSON.stringify({
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
    enums: enums.rows,
  });
}

export async function publicTableCount(client: Client): Promise<number> {
  const tableCount = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  );
  return Number(tableCount.rows[0]?.count ?? 0);
}
