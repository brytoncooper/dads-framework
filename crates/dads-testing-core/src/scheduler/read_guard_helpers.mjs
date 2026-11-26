import { Buffer } from "node:buffer";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";

const HELPERS_FILE = normalizeSlashes(fileURLToPath(import.meta.url));
const O_WRONLY = fs.constants.O_WRONLY;
const O_ACCMODE = fs.constants.O_WRONLY | fs.constants.O_RDWR;

export const CONFIG_ENV = "DADS_TEST_READ_GUARD_CONFIG";

export const ROOT_POLICY_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".oxlintrc.json",
  ".gitignore",
  "dads.testing.json",
  "dads.project.json",
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.ts",
  "eslint.config.mts",
  "vitest.workspace.ts",
  "vitest.workspace.mts",
  "vitest.workspace.js",
  "vitest.workspace.mjs",
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vitest.setup.ts",
  "vitest.setup.mts",
  "vitest.setup.js",
  ".env",
  ".env.local",
  ".env.test",
  ".env.test.local",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts",
  "next.config.cjs",
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "drizzle.config.mts",
  "tailwind.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.cjs",
  "postcss.config.ts",
  "babel.config.js",
  "babel.config.mjs",
  "babel.config.cjs",
  "babel.config.json",
  ".babelrc",
  ".babelrc.json",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
]);

export const ANCESTOR_POLICY_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.test",
  ".env.test.local",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
  "package.json",
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts",
  "next.config.cjs",
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "babel.config.js",
  "babel.config.mjs",
  "babel.config.json",
]);

export const NODE_RUNNERS = new Set(["node", "nodejs", "tsx", "ts-node"]);
export const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
export const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--input-type",
  "--title",
  "--max-old-space-size",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--watch-path",
  "--env-file",
  "--env-file-if-exists",
  "--diagnostic-dir",
  "--redirect-warnings",
  "--heapsnapshot-signal",
  "--cpu-prof-dir",
  "--cpu-prof-name",
  "--heap-prof-dir",
  "--heap-prof-name",
]);
const WRITE_ONLY_FLAGS = new Set(["w", "wx", "xw", "a", "ax", "xa", "as"]);

export function normalizeSlashes(value) {
  return value.includes("\\") ? value.replace(/\\/g, "/") : value;
}

export function withTrailingSlash(value) {
  const norm = normalizeSlashes(value);
  return norm.endsWith("/") ? norm : `${norm}/`;
}

function escapeRegex(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function compileGlobRegex(pattern) {
  const segments = pattern.split("/");
  let source = "^";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (seg === "**") {
      if (i === 0 && isLast) source += ".*";
      else if (i === 0) source += "(?:.+/)?";
      else if (isLast) source += "(?:/.*)?";
      else source += "/(?:.+/)?";
      continue;
    }
    if (i > 0 && segments[i - 1] !== "**") source += "/";
    source += escapeRegex(seg).replace(/\*/g, "[^/]*");
  }
  return new RegExp(`${source}$`);
}

export function isTsconfigName(base) {
  return base.startsWith("tsconfig") && base.endsWith(".json");
}

export function isIgnoredInternalRel(rel) {
  if (rel === "node_modules" || rel.startsWith("node_modules/") || rel.includes("/node_modules/")) {
    return true;
  }
  if (rel.charCodeAt(0) !== 46 && !rel.includes("/.")) return false;
  return (
    rel === ".git" ||
    rel.startsWith(".git/") ||
    rel.includes("/.git/") ||
    rel === ".dads" ||
    rel.startsWith(".dads/") ||
    rel.includes("/.dads/") ||
    rel === ".vitest" ||
    rel.startsWith(".vitest/") ||
    rel.includes("/.vitest/") ||
    rel === ".vite" ||
    rel.startsWith(".vite/") ||
    rel.includes("/.vite/")
  );
}

function parseStackFrame(line) {
  const paren = /\((.+):(\d+):\d+\)\s*$/.exec(line);
  if (paren) return { file: paren[1], lineNumber: paren[2] };
  const bare = /^\s*at\s+(?:async\s+)?(.+):(\d+):\d+\s*$/.exec(line);
  return bare ? { file: bare[1], lineNumber: bare[2] } : undefined;
}

function captureStack() {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 25;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}

export function classifyCaller(wsRoot, wsRootRaw, selfFile) {
  const stack = captureStack();
  if (!stack) return { isUserCode: false, location: undefined };
  const lines = stack.split("\n");
  let sawNodeModules = false;
  let sawEval = false;
  let sawExternalScript = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes("node:internal/") || line.includes("(node:") || line.includes(" at node:")) continue;
    if (line.includes("/node_modules/") || line.includes("\\node_modules\\")) {
      sawNodeModules = true;
      continue;
    }
    if (line.includes("[eval")) {
      sawEval = true;
      continue;
    }
    const frame = parseStackFrame(line);
    if (!frame) continue;
    let filePath = frame.file;
    if (filePath.startsWith("file://")) {
      try {
        filePath = fileURLToPath(filePath);
      } catch {
        continue;
      }
    }
    filePath = normalizeSlashes(filePath);
    if (filePath === selfFile || filePath === HELPERS_FILE) continue;
    let rel;
    if (filePath.startsWith(wsRoot)) rel = filePath.slice(wsRoot.length);
    else if (wsRootRaw && filePath.startsWith(wsRootRaw)) rel = filePath.slice(wsRootRaw.length);
    else {
      sawExternalScript = true;
      continue;
    }
    if (!isIgnoredInternalRel(rel)) {
      return { isUserCode: true, location: `${rel}:${frame.lineNumber}`, viaNodeModules: sawNodeModules };
    }
  }
  if (sawEval || (sawExternalScript && !sawNodeModules)) {
    return { isUserCode: true, location: undefined, viaNodeModules: sawNodeModules };
  }
  return { isUserCode: false, location: undefined, viaNodeModules: sawNodeModules };
}

export function rawPathToString(rawPath) {
  if (typeof rawPath === "string") return rawPath;
  if (rawPath instanceof URL) {
    if (rawPath.protocol !== "file:") return undefined;
    try {
      return fileURLToPath(rawPath);
    } catch {
      return undefined;
    }
  }
  return Buffer.isBuffer(rawPath) ? rawPath.toString("utf8") : undefined;
}

export function globLiteralPrefix(pattern) {
  const parts = normalizeSlashes(pattern).split("/");
  const kept = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[") || part.includes("{")) break;
    kept.push(part);
  }
  return kept.join("/") || ".";
}

export function isWriteOnlyOpenFlag(flags) {
  if (typeof flags === "string") return WRITE_ONLY_FLAGS.has(flags);
  return typeof flags === "number" && (flags & O_ACCMODE) === O_WRONLY;
}

export function buildAllowlist(config) {
  let allowAll = false;
  const projectRoots = [];
  const projectRootExact = new Set();
  const ancestorDirs = new Set([""]);
  for (const raw of config.allowedProjectRoots || []) {
    const trimmed = normalizeSlashes(String(raw)).replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed === "" || trimmed === ".") {
      allowAll = true;
      break;
    }
    projectRootExact.add(trimmed);
    projectRoots.push(`${trimmed}/`);
    let cursor = trimmed;
    for (let idx = cursor.lastIndexOf("/"); idx !== -1; idx = cursor.lastIndexOf("/")) {
      cursor = cursor.slice(0, idx);
      ancestorDirs.add(cursor);
    }
  }
  for (const raw of config.allowedAncestorDirs || []) {
    const trimmed = normalizeSlashes(String(raw)).replace(/^\.\//, "").replace(/\/+$/, "");
    ancestorDirs.add(trimmed === "." ? "" : trimmed);
  }
  const extraFiles = new Set();
  for (const raw of config.allowedExtraFiles || []) {
    const trimmed = normalizeSlashes(String(raw)).replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed.length > 0) extraFiles.add(trimmed);
  }
  const impactExact = new Set();
  const impactPrefixes = [];
  const impactRegexes = [];
  for (const raw of config.allowedImpactPaths || []) {
    const trimmed = normalizeSlashes(String(raw)).replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed === "" || trimmed === "." || trimmed === "**") {
      allowAll = true;
      break;
    }
    if (trimmed.includes("*")) impactRegexes.push(compileGlobRegex(trimmed));
    else {
      impactExact.add(trimmed);
      impactPrefixes.push(`${trimmed}/`);
    }
  }
  return {
    allowAll,
    projectRoots,
    projectRootExact,
    ancestorDirs,
    extraFiles,
    impactExact,
    impactPrefixes,
    impactRegexes,
  };
}
