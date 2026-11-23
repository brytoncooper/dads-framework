/**
 * Proves every relative link in the tracked documentation still points at a
 * file that exists.
 *
 * Documentation rots quietly: a package moves into a domain folder, a document
 * is renamed, and the link keeps rendering as a link. Only following it finds
 * out. This check follows every one of them on every `npm run verify`.
 *
 * It follows relative targets only. Absolute URLs and `mailto:` are somebody
 * else's network to reach, and a bare `#fragment` is a heading anchor, not a
 * path. Fenced code blocks are skipped, because a link inside an example is
 * illustration, not navigation.
 *
 *   node scripts/checks/check-markdown-links.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Matches `[text](target)` and `![alt](target)`, target up to `)` or space. */
const INLINE_LINK = /\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Matches a reference definition: `[label]: target "optional title"`. */
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s<>]+)>?/;

/** A target Claude cannot resolve on disk, and should not try to. */
function isExternal(target) {
  return target.startsWith("#") || target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

/** Strips the anchor and query a browser would use, leaving the file path. */
function toFilePath(target) {
  const withoutFragment = target.split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

/** Every relative target in one document, with the line it was written on. */
export function collectLinkTargets(text) {
  const targets = [];
  let insideFence = false;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const found = [];
    for (const match of line.matchAll(INLINE_LINK)) found.push(match[1]);
    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition !== null) found.push(definition[1]);

    for (const target of found) {
      if (isExternal(target)) continue;
      const path = toFilePath(target);
      if (path.length === 0) continue;
      targets.push({ line: index + 1, target, path });
    }
  }

  return targets;
}

/**
 * The repository this check belongs to, read from the script's own location:
 * `npm run verify` runs from the root, but a direct `node` invocation from
 * anywhere else must still check this checkout.
 */
function repositoryRoot() {
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..");
}

function listTrackedMarkdown(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z", "*.md"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  return output.split("\0").filter((entry) => entry.length > 0);
}

export function checkMarkdownLinks({ root, files }) {
  const problems = [];
  let checkedLinkCount = 0;

  for (const relPath of files) {
    let text;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const link of collectLinkTargets(text)) {
      checkedLinkCount += 1;
      const resolved = link.path.startsWith("/") ? join(root, link.path) : join(root, dirname(relPath), link.path);
      if (existsSync(resolved)) continue;
      problems.push(`${relPath}:${String(link.line)}: ${link.target}`);
    }
  }

  if (problems.length > 0) {
    return {
      exitCode: 1,
      output: `${["markdown links that point at nothing:", ...problems].join("\n")}\n`,
    };
  }
  return {
    exitCode: 0,
    output: `markdown links: all resolve (${String(checkedLinkCount)} links in ${String(files.length)} files)\n`,
  };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const root = repositoryRoot();
  const result = checkMarkdownLinks({ root, files: listTrackedMarkdown(root) });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
