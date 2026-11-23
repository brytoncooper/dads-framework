import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import { z } from "zod";

const directive = "<!-- dads:excerpt ";

// Only the starter files shown by these guides may be copied into the page.
const publicSources = [
  "assembly/session-subjects.ts",
  "assembly/scim.ts",
  "domains/tenants/server/scim-binding-route.ts",
  "domains/tenants/server/permission-routes.ts",
  "domains/tenants/server/audit-export.ts",
  "assembly/staff-impersonation-services.ts",
  "assembly/feature-previews.ts",
] as const;

const selectionSchema = z.strictObject({
  path: z.enum(publicSources),
  language: z.literal("ts"),
  from: z.string(),
  through: z.string(),
});

function parseSelection(comment: string) {
  if (!comment.endsWith("-->")) throw new Error("Expected a closing comment.");
  const value: unknown = JSON.parse(comment.slice(directive.length, -3));
  return selectionSchema.parse(value);
}

function findAnchor(lines: readonly string[], text: string) {
  const anchor = text.split(/\r?\n/u);
  const matchesAt = (_line: string, index: number) => anchor.every((line, offset) => lines[index + offset] === line);
  const first = lines.findIndex(matchesAt);
  if (first < 0 || first !== lines.findLastIndex(matchesAt)) {
    throw new Error(`Expected one source anchor matching ${JSON.stringify(text)}.`);
  }
  return { first, last: first + anchor.length - 1 };
}

async function renderExcerpt(comment: string, watchSource: (path: string) => void): Promise<string> {
  const selection = parseSelection(comment);
  const starter = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const path = resolve(starter, selection.path);
  if ((await realpath(path)) !== path) {
    throw new Error("The excerpt source must be a file in the starter.");
  }
  watchSource(path);
  const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
  const start = findAnchor(lines, selection.from).first;
  const end = findAnchor(lines, selection.through).last;
  if (end < start) throw new Error("The end line precedes the start line.");
  const excerpt = lines
    .slice(start, end + 1)
    .join("\n")
    .trimEnd();
  const fence = "`".repeat((excerpt.match(/`+/gu) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3));
  return [`\`${selection.path}\``, "", fence + selection.language, excerpt, fence, "", ""].join("\n");
}

export async function expandGuideExcerpts(
  markdown: string,
  guide: string,
  watchSource: (path: string) => void,
): Promise<string> {
  const parser = new Marked();
  const tokens = parser.lexer(markdown);
  const excerpts = new Set(
    tokens.filter(
      (token) =>
        token.type === "html" &&
        token.block === true &&
        typeof token.text === "string" &&
        token.text.trimStart().startsWith(directive),
    ),
  );
  try {
    void parser.walkTokens(tokens, (token) => {
      if (token.type === "html" && token.raw.trimStart().startsWith(directive) && !excerpts.has(token)) {
        throw new Error("Place source excerpts in their own Markdown block.");
      }
    });
    if (excerpts.size === 0) return markdown;
    const blocks = await Promise.all(
      tokens.map((token) =>
        excerpts.has(token) ? renderExcerpt(token.raw.trim(), watchSource) : Promise.resolve(token.raw),
      ),
    );
    return blocks.join("");
  } catch (cause) {
    throw new Error(`Invalid example excerpt in ${guide}.`, { cause });
  }
}
