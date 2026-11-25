import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import moduleMod from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import util from "node:util";
import { isMainThread } from "node:worker_threads";
import {
  ANCESTOR_POLICY_BASENAMES,
  buildAllowlist,
  classifyCaller,
  CONFIG_ENV,
  globLiteralPrefix,
  isIgnoredInternalRel,
  isTsconfigName,
  isWriteOnlyOpenFlag,
  NODE_RUNNERS,
  normalizeSlashes,
  rawPathToString,
  ROOT_POLICY_BASENAMES,
  withTrailingSlash,
} from "./read_guard_helpers.mjs";

const SELF_FILE = normalizeSlashes(fileURLToPath(import.meta.url));

function installReadGuard() {
  const configPath = process.env[CONFIG_ENV];
  if (!configPath) return;

  const origReadFileSync = fs.readFileSync;
  const origAppendFileSync = fs.appendFileSync;
  let config;
  try {
    config = JSON.parse(origReadFileSync(configPath, "utf8"));
  } catch {
    return;
  }
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
    try {
      origAppendFileSync(reportPath, payload, "utf8");
    } catch {
      /* never mask exit status */
    }
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
    if (isMetaOnly && (rel === "" || allow.ancestorDirs.has(rel))) {
      approvedMetaRel.add(rel);
      return;
    }
    if (rel.length === 0) rel = ".";
    if (violations.has(rel)) return;

    const caller = classifyCaller(wsRoot, wsRootRaw, SELF_FILE);
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
    const base = path
      .basename(file)
      .toLowerCase()
      .replace(/\.(exe|cmd|bat)$/, "");
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
    const wrapped = function (...args) {
      checkChildProcessCall(args, api);
      return orig.apply(this, args);
    };
    const customPromisify = orig[util.promisify.custom];
    if (typeof customPromisify === "function") {
      wrapped[util.promisify.custom] = function (...args) {
        checkChildProcessCall(args, api);
        return customPromisify.apply(this, args);
      };
    }
    childProcess[name] = wrapped;
  }

  for (const name of [
    "readFileSync",
    "readFile",
    "readdirSync",
    "readdir",
    "createReadStream",
    "opendirSync",
    "opendir",
    "readlinkSync",
    "readlink",
    "openAsBlob",
  ]) {
    wrapPathMethod(fs, name, `fs.${name}`, false);
  }
  for (const name of [
    "existsSync",
    "statSync",
    "stat",
    "lstatSync",
    "lstat",
    "accessSync",
    "access",
    "realpathSync",
    "realpath",
  ]) {
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
