import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

import { Marked } from "marked";

const CHECK_EXAMPLE = "<!-- dads:check-example -->";
const TYPESCRIPT = new Map([
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
]);
const USAGE_LANGUAGES = new Set([
  ...TYPESCRIPT.keys(),
  "sh",
  "bash",
  "shell",
  "console",
  "powershell",
  "ps1",
  "cmd",
  "css",
  "js",
  "jsx",
  "javascript",
  "json",
  "yaml",
  "yml",
]);

function codeLanguage(token) {
  if (token?.type !== "code") return undefined;
  return token.lang?.trim().split(/\s+/u)[0];
}

export function readReadmeExamples(markdown) {
  const tokens = new Marked().lexer(markdown).filter(({ type }) => type !== "space");
  let inTryIt = false;
  let hasTryIt = false;
  let hasUsage = false;
  let hasTypeScriptUsage = false;
  let hasCheckedTypeScriptUsage = false;
  const snippets = [];
  const errors = [];

  for (const [index, token] of tokens.entries()) {
    if (token.type === "heading" && token.depth <= 2) {
      inTryIt = token.depth === 2 && token.text === "Try it";
      hasTryIt ||= inTryIt;
    }
    const language = codeLanguage(token);
    const hasCode = language !== undefined && token.text.trim() !== "";
    if (inTryIt && hasCode) {
      hasUsage ||= USAGE_LANGUAGES.has(language);
      hasTypeScriptUsage ||= TYPESCRIPT.has(language);
    }
    if (token.type !== "html" || token.text.trim() !== CHECK_EXAMPLE) continue;

    const next = tokens[index + 1];
    const extension = TYPESCRIPT.get(codeLanguage(next));
    if (extension === undefined || next.text.trim() === "") {
      errors.push("the dads:check-example marker needs a following nonempty TypeScript or TSX fence");
      continue;
    }
    hasCheckedTypeScriptUsage ||= inTryIt;
    snippets.push({ extension, code: next.text });
  }

  if (!hasTryIt) errors.push("missing a ## Try it section");
  else if (!hasUsage) errors.push("## Try it needs a labeled setup or usage code block");
  if (hasTypeScriptUsage && !hasCheckedTypeScriptUsage) {
    errors.push("mark a TypeScript example in ## Try it with " + CHECK_EXAMPLE);
  }
  return { errors, snippets };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function publicPackages(root, packages = readJson(join(root, "dads.project.json")).packages) {
  return packages.filter((entry) => {
    if (!entry.root.startsWith("packages/")) return false;
    const manifest = readJson(join(root, entry.root, "package.json"));
    return manifest.private !== true && manifest.publishConfig?.access !== "restricted";
  });
}

function compileExamples(root, snippets) {
  if (snippets.length === 0) return;
  const cache = join(root, ".dads");
  mkdirSync(cache, { recursive: true });
  const temp = mkdtempSync(join(cache, "readme-examples-"));
  const files = new Map();
  try {
    for (const [index, snippet] of snippets.entries()) {
      const directory = join(temp, String(index + 1));
      mkdirSync(directory);
      const file = join(directory, `example.${snippet.extension}`);
      writeFileSync(file, snippet.code);
      files.set(relative(root, file), `${snippet.name} README.md (example ${snippet.number})`);
    }
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript-native/bin/tsc",
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "--moduleDetection",
        "force",
        "--jsx",
        "react-jsx",
        "--pretty",
        "false",
        ...files.keys(),
      ],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    let diagnostics = [error.stdout, error.stderr].filter(Boolean).join("\n");
    for (const [file, label] of files) {
      diagnostics = diagnostics.replaceAll(file.replaceAll("\\", "/"), label);
    }
    throw new Error(
      `README examples did not typecheck. Run npm run build before checking docs.\n${diagnostics || error.message}`,
      { cause: error },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function checkPackageExamples(root) {
  const packages = publicPackages(root);
  const snippets = [];
  const problems = [];
  for (const { name, root: directory } of packages) {
    let markdown;
    try {
      markdown = readFileSync(join(root, directory, "README.md"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      problems.push(`${name}: missing ${directory}/README.md`);
      continue;
    }
    const { errors, snippets: packageSnippets } = readReadmeExamples(markdown);
    problems.push(...errors.map((error) => `${name}: ${error}`));
    snippets.push(
      ...packageSnippets.map((snippet, index) => ({
        ...snippet,
        name,
        number: index + 1,
      })),
    );
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  compileExamples(root, snippets);
  return { packages: packages.length, snippets: snippets.length };
}
