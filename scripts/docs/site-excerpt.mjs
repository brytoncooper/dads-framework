const DIRECTIVE = "<!-- dads:excerpt ";
const LANGUAGES = new Map([
  ["sh", ".md"],
  ["ts", ".ts"],
]);

function uniqueLine(lines, text, fail) {
  const first = lines.indexOf(text);
  if (first === -1 || lines.lastIndexOf(text) !== first) {
    fail(`expected exactly one line matching ${JSON.stringify(text)}`);
  }
  return first;
}

export function sourceExcerpt({ token, page, linkedSources, files }) {
  const directive = token.trim();
  if (!directive.startsWith(DIRECTIVE)) return undefined;
  const fail = (message) => {
    throw new Error(`${page}: invalid docs excerpt: ${message}.`);
  };
  if (!directive.endsWith("-->")) fail("expected a closing comment");
  let selection;
  try {
    selection = JSON.parse(directive.slice(DIRECTIVE.length, -3));
  } catch {
    fail("expected a JSON selection");
  }
  const { path, language, from, through } = selection ?? {};
  const extension = LANGUAGES.get(language);
  if (
    typeof path !== "string" ||
    !extension ||
    !path.endsWith(extension) ||
    typeof from !== "string" ||
    typeof through !== "string"
  ) {
    fail("expected a source path, language, start line and end line");
  }
  const key = `source/${path}`;
  if (!linkedSources.has(key) || !files.has(key)) {
    fail(`link to ${path} in the guide before excerpting it`);
  }
  const lines = files.get(key).toString().split(/\r?\n/u);
  const start = uniqueLine(lines, from, fail);
  const end = uniqueLine(lines, through, fail);
  if (end < start) fail("the end line precedes the start line");
  const excerpt = lines
    .slice(start, end + 1)
    .join("\n")
    .trimEnd();
  return { language, excerpt };
}
