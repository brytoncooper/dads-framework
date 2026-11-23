/**
 * The only statements a `buildsIndexesConcurrently` migration may run. Those
 * files run outside a transaction, so anything else they could carry would
 * lose the all-or-nothing guarantee every other migration keeps.
 */
export type ConcurrentIndexStatement =
  | {
      kind: "create";
      sql: string;
      /** The index's name as PostgreSQL stores it (unquoted, case-folded). */
      indexName: string;
      /** The table as written, for `to_regclass` to resolve. */
      tableReference: string;
    }
  | { kind: "drop"; sql: string };

export type ConcurrentIndexStatementParse =
  | { ok: true; statement: ConcurrentIndexStatement }
  | { ok: false; reason: string };

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?`;

const CREATE_PATTERN = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(${IDENTIFIER})\s+ON\s+(?:ONLY\s+)?(${QUALIFIED})[\s(]`,
  "i",
);
const DROP_PATTERN = new RegExp(
  String.raw`^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+${QUALIFIED}(?:\s+RESTRICT)?$`,
  "i",
);

/**
 * NAMEDATALEN - 1. PostgreSQL silently truncates a longer identifier, so the
 * runner's post-build lookup by the written name would never find the index
 * (node-pg-migrate's generated `<table>_<columns>_index` names can pass it).
 */
const MAX_IDENTIFIER_BYTES = 63;

const ALLOWED =
  "only CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <name> ON <table> ... and DROP INDEX CONCURRENTLY IF EXISTS <name> are allowed";

/**
 * Accepts one statement — a `pgm.sql` step or a `pgm.createIndex` /
 * `pgm.dropIndex` with `concurrently` and `ifNotExists` / `ifExists`.
 * A `;` anywhere but the end, or any comment, is refused: a second statement
 * hidden behind one would run outside the transaction too.
 */
export function parseConcurrentIndexStatement(
  step: string,
): ConcurrentIndexStatementParse {
  const sql = step.trim().replace(/;\s*$/, "").trim();
  if (sql.includes(";"))
    return { ok: false, reason: `one statement per step; ${ALLOWED}` };
  if (sql.includes("--") || sql.includes("/*"))
    return { ok: false, reason: `comments are not allowed; ${ALLOWED}` };

  const create = CREATE_PATTERN.exec(sql);
  if (create !== null) {
    const [, rawName, tableReference] = create;
    if (rawName === undefined || tableReference === undefined)
      return { ok: false, reason: ALLOWED };
    const indexName = storedIdentifier(rawName);
    if (Buffer.byteLength(indexName, "utf8") > MAX_IDENTIFIER_BYTES)
      return {
        ok: false,
        reason: `index name ${indexName} is longer than ${MAX_IDENTIFIER_BYTES} bytes, so PostgreSQL would truncate it and the build could not be checked; pass an explicit short name (pgm.createIndex(..., { name: "<name>" }))`,
      };
    return {
      ok: true,
      statement: { kind: "create", sql, indexName, tableReference },
    };
  }
  if (DROP_PATTERN.test(sql))
    return { ok: true, statement: { kind: "drop", sql } };
  return { ok: false, reason: ALLOWED };
}

/** `"Mixed""Name"` becomes `Mixed"Name`; `Plain` becomes `plain`, as PostgreSQL folds it. */
function storedIdentifier(raw: string): string {
  return raw.startsWith('"')
    ? raw.slice(1, -1).replaceAll('""', '"')
    : raw.toLowerCase();
}
