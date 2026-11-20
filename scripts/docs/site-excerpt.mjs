import { Marked } from "marked";

import { validateGuideCode } from "./site-examples.mjs";

const DIRECTIVE = "<!-- dads:excerpt ";
const LANGUAGES = new Map([
  ["sh", ".md"],
  ["ts", ".ts"],
  ["tsx", ".tsx"],
]);

function uniqueLine(lines, text, fail) {
  const first = lines.indexOf(text);
  if (first === -1 || lines.lastIndexOf(text) !== first) {
    fail(`expected exactly one line matching ${JSON.stringify(text)}`);
  }
  return first;
}

export function sourceExcerpt({ token, page, readFile }) {
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
  const lines = readFile(path).toString().split(/\r?\n/u);
  const start = uniqueLine(lines, from, fail);
  const end = uniqueLine(lines, through, fail);
  if (end < start) fail("the end line precedes the start line");
  const excerpt = lines
    .slice(start, end + 1)
    .join("\n")
    .trimEnd();
  return { language, excerpt };
}

function fencedExcerpt({ language, excerpt }) {
  const backticks = excerpt.match(/`+/gu) ?? [];
  const length = backticks.reduce(
    (longest, run) => Math.max(longest, run.length + 1),
    3,
  );
  const fence = "`".repeat(length);
  return `${fence}${language}\n${excerpt}\n${fence}\n\n`;
}

export function expandPageExamples(page, readFile) {
  const parser = new Marked();
  const tokens = parser.lexer(page.markdown);
  const excerpts = new Map();
  for (const token of tokens) {
    if (token.type !== "html" || !token.block) continue;
    const excerpt = sourceExcerpt({
      token: token.text,
      page: page.path,
      readFile,
    });
    if (excerpt) excerpts.set(token, fencedExcerpt(excerpt));
  }
  parser.walkTokens(tokens, (token) => {
    validateGuideCode(page, token);
    if (
      token.type === "html" &&
      token.text.trimStart().startsWith(DIRECTIVE) &&
      !excerpts.has(token)
    ) {
      throw new Error(
        `${page.path}: place docs excerpts in their own Markdown block.`,
      );
    }
  });
  if (excerpts.size === 0) return page.markdown;
  return tokens.map((token) => excerpts.get(token) ?? token.raw).join("");
}
