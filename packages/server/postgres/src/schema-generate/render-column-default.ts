export type RenderedDefault = {
  readonly chain: string;
  readonly usesSql: boolean;
};

const NUMERIC_TYPES = new Set(["integer", "smallint", "bigint", "real", "double precision"]);

/** Escapes a SQL expression so it can safely appear inside a JS template literal. */
export function escapeSqlTemplate(expression: string): string {
  return expression.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function tryParseJsonDefault(trimmed: string): RenderedDefault | undefined {
  const match = /^'((?:[^']|'')*)'::jsonb?$/i.exec(trimmed);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.replaceAll("''", "'"));
    return { chain: `.default(${JSON.stringify(parsed)})`, usesSql: false };
  } catch {
    return undefined;
  }
}

function tryParseStringDefault(trimmed: string, basePgType: string): RenderedDefault | undefined {
  if (basePgType === "jsonb" || basePgType === "json") {
    return tryParseJsonDefault(trimmed);
  }
  const match = /^'((?:[^']|'')*)'(?:::[a-zA-Z0-9_." ]+)?$/i.exec(trimmed);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return { chain: `.default(${JSON.stringify(raw.replaceAll("''", "'"))})`, usesSql: false };
}

function tryParseNumericDefault(trimmed: string, basePgType: string): RenderedDefault | undefined {
  const unwrapped = /^\((-?\d+(?:\.\d+)?)\)$/.exec(trimmed)?.[1] ?? trimmed;
  if (!/^-?\d+(?:\.\d+)?$/.test(unwrapped)) return undefined;
  if (basePgType === "numeric" || basePgType === "decimal") {
    return { chain: `.default(${JSON.stringify(unwrapped)})`, usesSql: false };
  }
  if (NUMERIC_TYPES.has(basePgType)) {
    return { chain: `.default(${unwrapped})`, usesSql: false };
  }
  return undefined;
}

/**
 * Translates a PostgreSQL column default expression into the idiomatic Drizzle
 * column default chain (`.defaultNow()`, `.defaultRandom()`, `.default(...)`,
 * or `.default(sql\`...\`)`).
 */
export function renderColumnDefault(expression: string | null, basePgType: string): RenderedDefault {
  if (expression === null) return { chain: "", usesSql: false };
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { chain: "", usesSql: false };

  if (/^(?:now\(\)|current_timestamp|transaction_timestamp\(\))$/i.test(trimmed)) {
    return { chain: ".defaultNow()", usesSql: false };
  }
  if (/^(?:gen_random_uuid\(\)|uuid_generate_v4\(\))$/i.test(trimmed)) {
    return { chain: ".defaultRandom()", usesSql: false };
  }
  if (trimmed === "true" || trimmed === "false") {
    return { chain: `.default(${trimmed})`, usesSql: false };
  }

  const numericDefault = tryParseNumericDefault(trimmed, basePgType);
  if (numericDefault !== undefined) return numericDefault;

  const stringDefault = tryParseStringDefault(trimmed, basePgType);
  if (stringDefault !== undefined) return stringDefault;

  return { chain: `.default(sql\`${escapeSqlTemplate(trimmed)}\`)`, usesSql: true };
}
