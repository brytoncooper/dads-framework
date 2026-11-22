import { posix } from "node:path";

import { Marked } from "marked";

import { validateGuideCode } from "./site-examples.mjs";

const DIRECTIVE = "<!-- dads:excerpt ";
const STARTER_ROOT = "apps/kit-workbench/";
const LANGUAGES = new Map([
  ["sh", ".md"],
  ["ts", ".ts"],
  ["tsx", ".tsx"],
]);

function uniqueAnchor(lines, text, fail) {
  const anchor = text.split(/\r?\n/u);
  const matches = (_, index) =>
    anchor.every((line, offset) => lines[index + offset] === line);
  const first = lines.findIndex(matches);
  if (first === -1 || lines.findLastIndex(matches) !== first) {
    const target = anchor.length === 1 ? "one line" : "one block of lines";
    fail(`expected exactly ${target} matching ${JSON.stringify(text)}`);
  }
  return { first, last: first + anchor.length - 1 };
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
  const {
    path,
    language,
    from,
    through,
    all,
    displayPath: customDisplayPath,
    note,
  } = selection ?? {};
  const extension = LANGUAGES.get(language);
  const fullFile = all === true;
  if (
    typeof path !== "string" ||
    !extension ||
    !path.endsWith(extension) ||
    (!fullFile && (typeof from !== "string" || typeof through !== "string"))
  ) {
    fail(
      "expected a source path, language, and start/end lines (or all: true)",
    );
  }
  if (
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.startsWith("../") ||
    /[\\`\r\n]/u.test(path)
  ) {
    fail("expected a relative source path without traversal");
  }
  const repositoryPath = page.startsWith(`${STARTER_ROOT}examples/`)
    ? `${STARTER_ROOT}${path}`
    : path;
  const rawContent = readFile(repositoryPath).toString();
  let excerpt;
  if (fullFile) {
    excerpt = rawContent.trimEnd();
  } else {
    const lines = rawContent.split(/\r?\n/u);
    const start = uniqueAnchor(lines, from, fail).first;
    const end = uniqueAnchor(lines, through, fail).last;
    if (end < start) fail("the end line precedes the start line");
    excerpt = lines
      .slice(start, end + 1)
      .join("\n")
      .trimEnd();
  }
  const displayPath =
    typeof customDisplayPath === "string" && customDisplayPath.length > 0
      ? customDisplayPath
      : repositoryPath.startsWith(STARTER_ROOT)
        ? repositoryPath.slice(STARTER_ROOT.length)
        : repositoryPath;
  const summary =
    typeof note === "string" && note.trim().length > 0
      ? note.trim()
      : undefined;
  return summary
    ? { language, excerpt, path: displayPath, note: summary }
    : { language, excerpt, path: displayPath };
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
  let previous;
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "html" && token.block) {
      const excerpt = sourceExcerpt({
        token: token.text,
        page: page.path,
        readFile,
      });
      if (excerpt) {
        const alreadyLabeled =
          previous?.type === "paragraph" &&
          previous.tokens.some(
            (inline) =>
              inline.type === "codespan" && inline.text === excerpt.path,
          );
        const label = alreadyLabeled
          ? ""
          : excerpt.note
            ? `\`${excerpt.path}\` — ${excerpt.note}\n\n`
            : `\`${excerpt.path}\`\n\n`;
        excerpts.set(token, label + fencedExcerpt(excerpt));
      }
    }
    previous = token;
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
