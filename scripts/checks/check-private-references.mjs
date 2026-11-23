import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const patterns = Object.freeze([
  Object.freeze({
    id: "local-machine-path",
    regex: /\/Users\/[A-Za-z0-9._-]+\//,
    reason: "a developer's local filesystem path, which can leak a username",
  }),
  Object.freeze({
    id: "secret-private-key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    reason: "a PEM-encoded private key block",
  }),
  Object.freeze({
    id: "secret-github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    reason: "a GitHub personal access or app token",
  }),
  Object.freeze({
    id: "secret-anthropic-key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{10,}/,
    reason: "an Anthropic API key",
  }),
  Object.freeze({
    id: "secret-aws-access-key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    reason: "an AWS access key id",
  }),
  Object.freeze({
    id: "secret-npm-token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/,
    reason: "an npm access token",
  }),
  Object.freeze({
    id: "secret-slack-token",
    regex: /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
    reason: "a Slack token",
  }),
  Object.freeze({
    id: "local-private-policy",
    regex: /(?:^|\/)private-references\.local\.json$/,
    scope: "path",
    reason: "an unpublished private scanner configuration",
  }),
]);

/**
 * Scans a list of files for denylisted patterns.
 *
 * `files` is an array of `{ absPath, relPath }` where `relPath` is the path
 * used for reporting and for matching against the allowlist. `allowlist` is
 * an array of `{ path, pattern, reason, exactText? }` entries. `activePatterns` defaults
 * to the public `patterns` export; callers that also load private patterns
 * (see `loadPrivatePatterns`) pass the combined list.
 */
export function scanFiles(files, allowlist, activePatterns = patterns) {
  const allowedReasons = new Map();
  for (const entry of allowlist) {
    const key = `${entry.path}::${entry.pattern}`;
    const entries = allowedReasons.get(key) ?? [];
    entries.push(entry);
    allowedReasons.set(key, entries);
  }

  const hits = [];
  const allowed = [];
  const seenAllowed = new Set();
  let scannedCount = 0;

  const pathPatterns = activePatterns.filter(({ scope }) => scope === "path");
  const contentPatterns = activePatterns.filter(({ scope }) => scope !== "path");
  for (const file of files) {
    const pathHits = pathPatterns.filter((pattern) => matchesPattern(pattern, file.relPath, file.relPath));
    if (pathHits.length > 0) {
      for (const { id } of pathHits) {
        hits.push({ path: "[redacted path]", line: 1, id, text: "[redacted]" });
      }
      continue;
    }
    let buffer;
    try {
      buffer = lstatSync(file.absPath).isSymbolicLink()
        ? Buffer.from(readlinkSync(file.absPath))
        : readFileSync(file.absPath);
    } catch (error) {
      // The working checkout can omit a tracked path or contain a submodule
      // directory. Symlinks themselves are scanned without following them.
      if (error?.code === "ENOENT" || error?.code === "EISDIR") continue;
      throw error;
    }
    if (isBinary(buffer)) continue;

    scannedCount += 1;
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = contentPatterns.filter((pattern) => matchesPattern(pattern, file.relPath, line));
      const redacted = matched.some((pattern) => pattern.sensitive === true || pattern.id.startsWith("secret-"));
      for (const pattern of matched) {
        const key = `${file.relPath}::${pattern.id}`;
        const exception = allowedReasons
          .get(key)
          ?.find((entry) => entry.exactText === undefined || entry.exactText === line.trim());
        if (exception !== undefined) {
          if (!seenAllowed.has(key)) {
            seenAllowed.add(key);
            allowed.push({
              path: file.relPath,
              id: pattern.id,
              reason: exception.reason,
            });
          }
          continue;
        }

        hits.push({
          path: file.relPath,
          line: index + 1,
          id: pattern.id,
          text: redacted ? "[redacted]" : line.trim(),
        });
      }
    }
  }

  return { scannedCount, hits, allowed };
}

export function matchesPattern(pattern, path, line) {
  if (pattern.filesPattern && !pattern.filesPattern.test(path)) return false;
  pattern.regex.lastIndex = 0;
  return pattern.regex.test(line);
}

function isBinary(buffer) {
  const sniffLength = Math.min(buffer.length, 8000);
  for (let index = 0; index < sniffLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function resolveRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex !== -1 && argv[rootIndex + 1]) {
    return resolve(argv[rootIndex + 1]);
  }
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function resolvePathsDir(argv) {
  const pathsIndex = argv.indexOf("--paths");
  if (pathsIndex === -1) return null;
  const value = argv[pathsIndex + 1];
  if (!value) throw new Error("--paths requires a directory argument");
  return resolve(value);
}

function resolvePrivatePatternsPath(argv) {
  const index = argv.indexOf("--private-patterns");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--private-patterns requires a file argument");
  }
  return resolve(value);
}

function listFilesUnder(directory) {
  const results = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() || entry.isSymbolicLink()) results.push(entryPath);
    }
  };
  visit(directory);
  return results;
}

function listGitFiles(root, gitArgs) {
  const output = execFileSync("git", ["-C", root, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Loads the private-only pattern file kept beside a checkout at
 * `<root>/scripts/checks/private-references.local.json`, if it exists. Each
 * entry is `{ id, regex, flags?, reason, files?, scope? }`. Use
 * `scope: "path"` to match filenames instead of file contents. The optional
 * `files` regular expression restricts either mode to a subset of paths. Returns `[]` when the file is absent. Throws
 * a clear error when the file exists but is not a well-formed pattern list.
 */
export function loadPrivatePatterns(root, explicitPath) {
  const defaultPath = "scripts/checks/private-references.local.json";
  const localPath = explicitPath ?? join(root, defaultPath);
  const label = explicitPath === undefined ? defaultPath : "private pattern file";
  let raw;
  try {
    raw = readFileSync(localPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && explicitPath === undefined) return [];
    if (error?.code === "ENOENT")
      throw new Error(`The requested ${label} does not exist.`, {
        cause: error,
      });
    throw error;
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }

  if (!Array.isArray(entries)) {
    throw new Error(`${label} must contain a JSON array of pattern entries`);
  }

  if (explicitPath !== undefined && entries.length === 0) {
    throw new Error(`The requested ${label} must contain at least one pattern`);
  }

  return entries.map((entry, index) => {
    const where = `${label} entry ${index}`;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.regex !== "string" ||
      entry.regex.length === 0 ||
      typeof entry.reason !== "string" ||
      entry.reason.length === 0
    ) {
      throw new Error(`${where} must have non-empty string "id", "regex", and "reason" fields`);
    }
    if (entry.flags !== undefined && typeof entry.flags !== "string") {
      throw new Error(`${where} ("${entry.id}") has a non-string "flags" field`);
    }
    if (entry.files !== undefined && typeof entry.files !== "string") {
      throw new Error(`${where} ("${entry.id}") has a non-string "files" field`);
    }

    let regex;
    try {
      regex = new RegExp(entry.regex, entry.flags ?? "");
    } catch {
      throw new Error(`${where} has an invalid "regex"`);
    }

    let filesPattern;
    if (entry.files !== undefined) {
      try {
        filesPattern = new RegExp(entry.files);
      } catch {
        throw new Error(`${where} has an invalid "files" pattern`);
      }
    }

    return Object.freeze({
      id: entry.id,
      regex,
      reason: entry.reason,
      sensitive: true,
      scope: entry.scope ?? "content",
      ...(filesPattern ? { filesPattern } : {}),
    });
  });
}

function loadAllowlist(root) {
  const allowlistPath = join(root, "scripts", "checks", "private-references.allow.json");
  try {
    return JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return [];
  }
}

export function main(argv) {
  const root = resolveRoot(argv);
  const pathsDir = resolvePathsDir(argv);
  const staged = argv.includes("--staged");

  let files;
  if (pathsDir) {
    files = listFilesUnder(pathsDir).map((absPath) => ({
      absPath,
      relPath: relative(pathsDir, absPath),
    }));
  } else {
    const gitArgs = staged ? ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"] : ["ls-files", "-z"];
    files = listGitFiles(root, gitArgs).map((relPath) => ({
      absPath: join(root, relPath),
      relPath,
    }));
  }

  const patternRoot = pathsDir ?? root;
  const activePatterns = [...patterns, ...loadPrivatePatterns(patternRoot, resolvePrivatePatternsPath(argv))];
  const allowlist = loadAllowlist(patternRoot);
  const result = scanFiles(files, allowlist, activePatterns);

  const lines = [];
  for (const entry of result.allowed) {
    lines.push(`allowed: ${entry.path}: ${entry.id} (${entry.reason})`);
  }

  if (result.hits.length > 0) {
    for (const hit of result.hits) {
      lines.push(`${hit.path}:${hit.line}: ${hit.id}: ${hit.text}`);
    }
    return { exitCode: 1, output: `${lines.join("\n")}\n` };
  }

  lines.push(`private references: clean (${result.scannedCount} files scanned)`);
  return { exitCode: 0, output: `${lines.join("\n")}\n` };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
