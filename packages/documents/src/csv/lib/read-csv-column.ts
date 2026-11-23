/** Doubled separators denote empty keys. Quoted bracket keys may contain dots. */
const PATH_MEMBER =
  /[^.[\]]+|\[\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\][^]+?))\s*\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;

/** A literal column name takes precedence over interpreting it as a path. */
export function readCsvColumn(row: Readonly<Record<string, unknown>>, key: string): unknown {
  if (key in row) return row[key];
  if (!/\.|\[[^\]]*\]/.test(key)) return undefined;
  const members = key.startsWith(".") ? [""] : [];
  for (const member of key.matchAll(PATH_MEMBER)) {
    members.push(pathMember(member));
  }
  if (members.length === 0) return undefined;

  let value: unknown = row;
  for (const name of members) {
    if (value === undefined || value === null) return undefined;
    value = Reflect.get(Object(value), name);
  }
  return value;
}

function pathMember(match: RegExpMatchArray): string {
  const quoted = match[1] ?? match[2];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1");
  return match[3]?.trim() ?? match[0];
}
