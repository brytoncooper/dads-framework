import { Buffer } from "node:buffer";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import moduleMod from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import util from "node:util";
import { isMainThread } from "node:worker_threads";

const CONFIG_ENV = "DADS_TEST_READ_GUARD_CONFIG";
const SELF_FILE = normalizeSlashes(fileURLToPath(import.meta.url));
const O_WRONLY = fs.constants.O_WRONLY;
const O_ACCMODE = fs.constants.O_WRONLY | fs.constants.O_RDWR;

const ROOT_POLICY_BASENAMES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock",
  ".oxlintrc.json", ".gitignore", "dads.testing.json", "dads.project.json",
  "eslint.config.mjs", "eslint.config.js", "eslint.config.ts", "eslint.config.mts",
  "vitest.workspace.ts", "vitest.workspace.mts", "vitest.workspace.js", "vitest.workspace.mjs",
  "vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs",
  "vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs",
  "vitest.setup.ts", "vitest.setup.mts", "vitest.setup.js",
  ".env", ".env.local", ".env.test", ".env.test.local",
  "next.config.js", "next.config.mjs", "next.config.ts", "next.config.mts", "next.config.cjs",
  "drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.mts",
  "tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs",
  "postcss.config.js", "postcss.config.mjs", "postcss.config.cjs", "postcss.config.ts",
  "babel.config.js", "babel.config.mjs", "babel.config.cjs", "babel.config.json",
  ".babelrc", ".babelrc.json",
]);

const ANCESTOR_POLICY_BASENAMES = new Set([
  ".env", ".env.local", ".env.test", ".env.test.local", "package.json",
  "vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs",
  "vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs",
  "next.config.js", "next.config.mjs", "next.config.ts", "next.config.mts", "next.config.cjs",
  "drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs",
  "tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs",
  "postcss.config.js", "postcss.config.mjs",
  "babel.config.js", "babel.config.mjs", "babel.config.json",
]);

const NODE_RUNNERS = new Set(["node", "nodejs", "tsx", "ts-node"]);
const WRITE_ONLY_FLAGS = new Set(["w", "wx", "xw", "a", "ax", "xa", "as"]);

function normalizeSlashes(value) {
  return value.includes("\\") ? value.replace(/\\/g, "/") : value;
}

function withTrailingSlash(value) {
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

function isTsconfigName(base) {
  return base.startsWith("tsconfig") && base.endsWith(".json");
}

function isIgnoredInternalRel(rel) {
  if (rel === "node_modules" || rel.startsWith("node_modules/") || rel.includes("/node_modules/")) {
    return true;
  }
  if (rel.charCodeAt(0) !== 46 && !rel.includes("/.")) return false;
  return (
    rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/") ||
    rel === ".dads" || rel.startsWith(".dads/") || rel.includes("/.dads/") ||
    rel === ".vitest" || rel.startsWith(".vitest/") || rel.includes("/.vitest/") ||
    rel === ".vite" || rel.startsWith(".vite/") || rel.includes("/.vite/")
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

function classifyCaller(wsRoot, wsRootRaw) {
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
      try { filePath = fileURLToPath(filePath); } catch { continue; }
    }
    filePath = normalizeSlashes(filePath);
    if (filePath === SELF_FILE) continue;
    let rel;
    if (filePath.startsWith(wsRoot)) rel = filePath.slice(wsRoot.length);
    else if (wsRootRaw && filePath.startsWith(wsRootRaw)) rel = filePath.slice(wsRootRaw.length);
    else { sawExternalScript = true; continue; }
    if (!isIgnoredInternalRel(rel)) return { isUserCode: true, location: `${rel}:${frame.lineNumber}` };
  }
  if (sawEval || (sawExternalScript && !sawNodeModules)) return { isUserCode: true, location: undefined };
  return { isUserCode: false, location: undefined };
}

function rawPathToString(rawPath) {
  if (typeof rawPath === "string") return rawPath;
  if (rawPath instanceof URL) {
    if (rawPath.protocol !== "file:") return undefined;
    try { return fileURLToPath(rawPath); } catch { return undefined; }
  }
  return Buffer.isBuffer(rawPath) ? rawPath.toString("utf8") : undefined;
}

function globLiteralPrefix(pattern) {
  const parts = normalizeSlashes(pattern).split("/");
  const kept = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[") || part.includes("{")) break;
    kept.push(part);
  }
  return kept.join("/") || ".";
}

function isWriteOnlyOpenFlag(flags) {
  if (typeof flags === "string") return WRITE_ONLY_FLAGS.has(flags);
  return typeof flags === "number" && (flags & O_ACCMODE) === O_WRONLY;
}

function buildAllowlist(config) {
  let allowAll = false;
  const projectRoots = [];
  const projectRootExact = new Set();
  const ancestorDirs = new Set([""]);
  for (const raw of config.allowedProjectRoots || []) {
    const trimmed = normalizeSlashes(String(raw)).replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed === "" || trimmed === ".") { allowAll = true; break; }
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
    if (trimmed === "" || trimmed === "." || trimmed === "**") { allowAll = true; break; }
    if (trimmed.includes("*")) impactRegexes.push(compileGlobRegex(trimmed));
    else { impactExact.add(trimmed); impactPrefixes.push(`${trimmed}/`); }
  }
  return { allowAll, projectRoots, projectRootExact, ancestorDirs, extraFiles, impactExact, impactPrefixes, impactRegexes };
}

function installReadGuard() {
  const configPath = process.env[CONFIG_ENV];
  if (!configPath) return;

  const origReadFileSync = fs.readFileSync;
  const origAppendFileSync = fs.appendFileSync;
  let config;
  try { config = JSON.parse(origReadFileSync(configPath, "utf8")); } catch { return; }
  if (!config || typeof config.workspaceRoot !== "string" || typeof config.reportPath !== "string") return;

  const wsRoot = withTrailingSlash(config.workspaceRoot);
  const wsRootNoSlash = wsRoot.slice(0, -1);
  const wsRootRaw =
    typeof config.workspaceRootRaw === "string" && config.workspaceRootRaw.length > 0
      ? withTrailingSlash(config.workspaceRootRaw)
      : "";
  const wsRootRawNoSlash = wsRootRaw ? wsRootRaw.slice(0, -1) : "";
  const reportPath = config.reportPath;
  const allow = buildAllowlist(config);
  const approvedAbs = new Set();
  const approvedRawRel = new Set();
  const approvedRel = new Set();
  const approvedMetaRel = new Set();
  const violations = new Map();
  const flushed = new Set();

  const origChdir = process.chdir;
  if (typeof origChdir === "function") {
    process.chdir = function (...args) {
      const result = origChdir.apply(this, args);
      approvedRawRel.clear();
      return result;
    };
  }

  function flushViolations() {
    if (violations.size === 0) return;
    let payload = "";
    for (const [rel, entry] of violations) {
      if (flushed.has(rel)) continue;
      flushed.add(rel);
      payload += `${JSON.stringify(entry)}\n`;
    }
    if (payload.length === 0) return;
    try { origAppendFileSync(reportPath, payload, "utf8"); } catch { /* never mask exit status */ }
  }

  process.on("exit", flushViolations);

  function isAllowedRel(rel) {
    if (allow.extraFiles.has(rel) || allow.projectRootExact.has(rel) || allow.impactExact.has(rel)) return true;
    for (let i = 0; i < allow.projectRoots.length; i += 1) {
      if (rel.startsWith(allow.projectRoots[i])) return true;
    }
    for (let i = 0; i < allow.impactPrefixes.length; i += 1) {
      if (rel.startsWith(allow.impactPrefixes[i])) return true;
    }
    for (let i = 0; i < allow.impactRegexes.length; i += 1) {
      if (allow.impactRegexes[i].test(rel)) return true;
    }
    const lastSlash = rel.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : rel.slice(0, lastSlash);
    const base = lastSlash === -1 ? rel : rel.slice(lastSlash + 1);
    if (dir === "") return ROOT_POLICY_BASENAMES.has(base) || isTsconfigName(base);
    if (allow.ancestorDirs.has(dir) || allow.projectRootExact.has(dir)) {
      return ANCESTOR_POLICY_BASENAMES.has(base) || isTsconfigName(base);
    }
    return false;
  }

  function checkPath(rawPath, api, isMetaOnly, baseDir) {
    if (allow.allowAll) return;
    const p = rawPathToString(rawPath);
    if (!p || p.length === 0) return;

    const isAbsPosix = p.charCodeAt(0) === 47;
    if (isAbsPosix) {
      if (approvedAbs.has(p)) return;
    } else if (!baseDir && approvedRawRel.has(p)) {
      return;
    }

    let abs;
    if (isAbsPosix) abs = p.includes("/.") || p.includes("//") ? path.resolve(p) : p;
    else abs = baseDir ? path.resolve(baseDir, p) : path.resolve(p);
    if (abs.includes("\\")) abs = abs.replace(/\\/g, "/");

    let rel;
    if (abs.startsWith(wsRoot)) rel = abs.slice(wsRoot.length);
    else if (wsRootRaw && abs.startsWith(wsRootRaw)) rel = abs.slice(wsRootRaw.length);
    else if (abs === wsRootNoSlash || (wsRootRawNoSlash && abs === wsRootRawNoSlash)) rel = "";
    else {
      if (isAbsPosix && approvedAbs.size < 50000) approvedAbs.add(p);
      return;
    }

    if (rel.endsWith("/")) rel = rel.slice(0, -1);
    if (isIgnoredInternalRel(rel)) {
      if (isAbsPosix && approvedAbs.size < 50000) approvedAbs.add(p);
      else if (!baseDir && approvedRawRel.size < 50000) approvedRawRel.add(p);
      return;
    }
    if (approvedRel.has(rel)) {
      if (isAbsPosix && approvedAbs.size < 50000) approvedAbs.add(p);
      else if (!baseDir && approvedRawRel.size < 50000) approvedRawRel.add(p);
      return;
    }
    if (isMetaOnly && approvedMetaRel.has(rel)) return;

    if (rel.length > 0 && isAllowedRel(rel)) {
      approvedRel.add(rel);
      if (isAbsPosix && approvedAbs.size < 50000) approvedAbs.add(p);
      else if (!baseDir && approvedRawRel.size < 50000) approvedRawRel.add(p);
      return;
    }
    if (isMetaOnly && (rel === "" || allow.ancestorDirs.has(rel))) { approvedMetaRel.add(rel); return; }
    if (rel.length === 0) rel = ".";
    if (violations.has(rel)) return;

    const caller = classifyCaller(wsRoot, wsRootRaw);
    if (!caller.isUserCode) return;
    const entry = { path: rel, ...(caller.location ? { location: caller.location } : {}), api };
    violations.set(rel, entry);
    if (!isMainThread) flushViolations();
  }

  function wrapPathMethod(target, name, api, isMetaOnly) {
    const orig = target[name];
    if (typeof orig !== "function") return;
    const wrapped = function (...args) {
      checkPath(args[0], api, isMetaOnly);
      return orig.apply(this, args);
    };
    if (typeof orig.native === "function") {
      const origNative = orig.native;
      wrapped.native = function (...args) {
        checkPath(args[0], `${api}.native`, isMetaOnly);
        return origNative.apply(this, args);
      };
    }
    target[name] = wrapped;
  }

  function wrapOpenMethod(target, name, api) {
    const orig = target[name];
    if (typeof orig !== "function") return;
    target[name] = function (...args) {
      if (!isWriteOnlyOpenFlag(args[1])) checkPath(args[0], api, false);
      return orig.apply(this, args);
    };
  }

  function wrapGlobMethod(target, name, api) {
    const orig = target[name];
    if (typeof orig !== "function") return;
    target[name] = function (...args) {
      const patterns = Array.isArray(args[0]) ? args[0] : [args[0]];
      const opts = args[1];
      const cwd = opts && typeof opts === "object" && opts.cwd ? rawPathToString(opts.cwd) : undefined;
      for (const pat of patterns) {
        if (typeof pat === "string") checkPath(globLiteralPrefix(pat), api, false, cwd);
      }
      return orig.apply(this, args);
    };
  }

  function checkChildProcessCall(args, api) {
    const file = args[0];
    if (typeof file !== "string" || file.length === 0) return;
    const cpArgs = Array.isArray(args[1]) ? args[1] : undefined;
    const opts = cpArgs ? args[2] : args[1];
    const cwd = opts && typeof opts === "object" && opts.cwd ? rawPathToString(opts.cwd) : undefined;
    if (file.includes("/") || file.includes("\\") || file.startsWith(".")) checkPath(file, api, false, cwd);
    const base = path.basename(file).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
    if (cpArgs && NODE_RUNNERS.has(base)) {
      for (const arg of cpArgs) {
        if (typeof arg !== "string" || arg.length === 0 || arg.startsWith("-")) continue;
        checkPath(arg, api, false, cwd);
        break;
      }
    }
  }

  function wrapChildProcessMethod(name, api) {
    const orig = childProcess[name];
    if (typeof orig !== "function") return;
    const wrapped = function (...args) { checkChildProcessCall(args, api); return orig.apply(this, args); };
    const customPromisify = orig[util.promisify.custom];
    if (typeof customPromisify === "function") {
      wrapped[util.promisify.custom] = function (...args) {
        checkChildProcessCall(args, api);
        return customPromisify.apply(this, args);
      };
    }
    childProcess[name] = wrapped;
  }

  for (const name of ["readFileSync", "readFile", "readdirSync", "readdir", "createReadStream", "opendirSync", "opendir", "readlinkSync", "readlink", "openAsBlob"]) {
    wrapPathMethod(fs, name, `fs.${name}`, false);
  }
  for (const name of ["existsSync", "statSync", "stat", "lstatSync", "lstat", "accessSync", "access", "realpathSync", "realpath"]) {
    wrapPathMethod(fs, name, `fs.${name}`, true);
  }
  wrapOpenMethod(fs, "openSync", "fs.openSync");
  wrapOpenMethod(fs, "open", "fs.open");
  wrapGlobMethod(fs, "globSync", "fs.globSync");
  wrapGlobMethod(fs, "glob", "fs.glob");

  for (const name of ["readFile", "readdir", "opendir", "readlink"]) {
    wrapPathMethod(fsPromises, name, `fs.promises.${name}`, false);
  }
  for (const name of ["stat", "lstat", "access", "realpath"]) {
    wrapPathMethod(fsPromises, name, `fs.promises.${name}`, true);
  }
  wrapOpenMethod(fsPromises, "open", "fs.promises.open");
  wrapGlobMethod(fsPromises, "glob", "fs.promises.glob");

  for (const name of ["execFileSync", "execFile", "spawnSync", "spawn"]) {
    wrapChildProcessMethod(name, `child_process.${name}`);
  }

  moduleMod.syncBuiltinESMExports();
}

installReadGuard();
