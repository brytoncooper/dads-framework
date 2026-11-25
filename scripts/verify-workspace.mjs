/**
 * Which part of a fingerprint a verify step depends on.
 *
 * A step is scoped one of two ways. `tree` is the whole checkout, ignored
 * inputs included. `package` is one workspace package: its own directory, the
 * directories of every workspace package it reaches through `package.json`
 * dependencies or `tsconfig.json` references (transitively), the root files
 * (the lockfile and the shared configs among them), and the ignored files
 * inside any of those.
 *
 * A package scope is only as good as the claim that the package reads nothing
 * else, so it is checked: a package whose source names a relative path that
 * leaves the package, asks for `process.cwd()`, or talks about a repository
 * root is widened to the whole tree. So is one whose manifest or tsconfig
 * cannot be read. The check over-widens on purpose; widening only costs a
 * rerun.
 */

import { readFileSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const COMMENTS_AND_STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
const RELATIVE_LITERAL = /["'`](\.\.?\/[^"'`\n]*)["'`]/gu;
const PARENT_LITERAL = /["'`]\.\.["'`]/gu;
const REACHES_CWD = /\bprocess\.cwd\(\)/u;
const MODULE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire(?:\.resolve)?\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*)["'`]([^"'`\n]+)["'`]/gu;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const NON_JS_ROOT_FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "clippy.toml",
  "rust-toolchain.toml",
  "rustfmt.toml",
  ".gitattributes",
  ".git-blame-ignore-revs",
]);

function stripComments(source) {
  return source.replace(COMMENTS_AND_STRINGS, (token) => (token.startsWith("/") ? " " : token));
}

function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/** `packages/*\/*` and friends: whole-segment `*`, `!` negation, nothing else. */
function matchesGlob(pattern, path) {
  const want = pattern.split("/");
  const have = path.split("/");
  if (want.length !== have.length) return false;
  return want.every((segment, index) => {
    if (segment === "*") return true;
    if (/[*?[\]{}]/u.test(segment)) {
      throw new Error(`workspace glob "${pattern}" is not supported`);
    }
    return segment === have[index];
  });
}

function isWorkspaceDirectory(globs, directory) {
  let included = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (matchesGlob(glob.slice(1), directory)) included = false;
    } else if (matchesGlob(glob, directory)) included = true;
  }
  return included;
}

/** Every workspace package in the tree: directory, name, and what it reaches. */
export function readWorkspace(root, entries) {
  const globs = readJson(root, "package.json").workspaces ?? [];
  const packages = new Map();
  for (const path of Object.keys(entries)) {
    if (!path.endsWith("/package.json")) continue;
    const directory = path.slice(0, -"/package.json".length);
    if (!isWorkspaceDirectory(globs, directory)) continue;
    const manifest = readJson(root, path);
    packages.set(directory, { directory, name: manifest.name, manifest });
  }
  addDeclaredFixturePackages(root, entries, globs, packages);
  return packages;
}

/**
 * Some standalone example fixtures are declared in `dads.project.json` and
 * matched by workspace globs without carrying their own `package.json`.
 * Including them keeps every test file owned instead of disabling partitioning.
 */
function addDeclaredFixturePackages(root, entries, globs, packages) {
  if (entries["dads.project.json"] === undefined) return;
  const project = readJson(root, "dads.project.json");
  for (const entry of project.packages ?? []) {
    const directory = entry.root;
    if (typeof directory !== "string" || packages.has(directory)) continue;
    if (!isWorkspaceDirectory(globs, directory)) continue;
    const prefix = `${directory}/`;
    if (!Object.keys(entries).some((path) => path.startsWith(prefix))) continue;
    const dependencies = Object.fromEntries((entry.allowedDependencies ?? []).map((name) => [name, "*"]));
    packages.set(directory, {
      directory,
      name: entry.name,
      manifest: { name: entry.name, dependencies },
    });
  }
}

function declaredWorkspaceNames(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));
}

/** Directories a package's tsconfig points at: references and `extends`. */
function tsconfigDirectories(root, directory, entries) {
  const path = `${directory}/tsconfig.json`;
  if (entries[path] === undefined) return [];
  const config = readJson(root, path);
  const targets = (config.references ?? []).map((reference) => reference.path);
  if (typeof config.extends === "string" && config.extends.startsWith(".")) {
    targets.push(dirname(config.extends));
  }
  return targets.map((target) => {
    const resolved = normalize(join(directory, target.replace(/\/tsconfig[^/]*\.json$/u, "")));
    if (resolved.startsWith("..")) throw new Error(`${path} reaches outside`);
    return resolved === "." ? "" : resolved.split("\\").join("/");
  });
}

/**
 * Workspace packages the source names in a module specifier, declared or not:
 * hoisting resolves an undeclared `@scope/name` import all the same.
 */
function importedWorkspaceNames(root, entries, directory, byName) {
  const prefix = `${directory}/`;
  const found = new Set();
  for (const file of Object.keys(entries)) {
    if (!file.startsWith(prefix) || !SOURCE_EXTENSION.test(file)) continue;
    const code = stripComments(readFileSync(join(root, file), "utf8"));
    for (const match of code.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) continue;
      const packageName = packageNameOf(specifier);
      if (byName.has(packageName)) found.add(packageName);
    }
  }
  return [...found];
}

function directNeeds(root, workspace, entries, directory) {
  const byName = new Map([...workspace.values()].map((item) => [item.name, item.directory]));
  const own = workspace.get(directory);
  const named = [...declaredWorkspaceNames(own.manifest), ...importedWorkspaceNames(root, entries, directory, byName)]
    .map((name) => byName.get(name))
    .filter((found) => found !== undefined);
  return [...named, ...tsconfigDirectories(root, directory, entries)];
}

/** The package and everything it reaches, as sorted directories. */
export function dependencyClosure(root, workspace, entries, directory) {
  const seen = new Set();
  const queue = [directory];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    if (workspace.has(next)) queue.push(...directNeeds(root, workspace, entries, next));
  }
  return [...seen].filter((found) => found !== "").sort();
}

function insideAnyDirectory(target, directories) {
  return directories.some((directory) => target === directory || target.startsWith(`${directory}/`));
}

function escapesPackage(file, source, directories, staticOnly) {
  const code = stripComments(source);
  if (staticOnly) {
    for (const match of code.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!insideAnyDirectory(target, directories)) return true;
    }
    return false;
  }
  if (REACHES_CWD.test(code)) return true;
  if ((code.match(PARENT_LITERAL) ?? []).length >= 2) return true;
  for (const match of code.matchAll(RELATIVE_LITERAL)) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
    if (!insideAnyDirectory(target, directories)) return true;
  }
  return false;
}

/** Does any source file in the package name a path outside its closure? */
export function reachesOutsidePackage(root, entries, directory, closure = [directory], options = {}) {
  const prefix = `${directory}/`;
  const staticOnly = options.staticOnly === true;
  return Object.keys(entries).some((file) => {
    if (!file.startsWith(prefix) || !SOURCE_EXTENSION.test(file)) return false;
    return escapesPackage(file, readFileSync(join(root, file), "utf8"), closure, staticOnly);
  });
}

/** Root-level JS/TS files: the lockfile, the shared configs, the root manifest. */
export function rootFiles(entries) {
  return Object.keys(entries)
    .filter(
      (path) =>
        !path.includes("/") &&
        !path.endsWith(".md") &&
        !NON_JS_ROOT_FILES.has(path) &&
        entries[path].startsWith("blob:"),
    )
    .sort()
    .map((path) => [path, entries[path]]);
}

function underAny(path, directories) {
  if (!path.includes("/")) return true;
  return directories.some((directory) => path.startsWith(`${directory}/`));
}

/**
 * The inputs a scope reads, ready to hash, or null when they cannot be known.
 * A package that reaches outside itself, or whose graph cannot be read, gets
 * the tree scope instead.
 */
export function scopeInputs(context, scope) {
  const { fingerprint } = context;
  if (fingerprint.error !== undefined || fingerprint.ignored === null) return null;
  if (scope.kind === "tree") {
    return {
      tree: fingerprint.tree,
      tracked: fingerprint.tracked,
      ignored: fingerprint.ignored,
    };
  }
  if (scope.kind !== "package") return null;
  const directories = packageDirectories(context, scope.directory, scope.staticOnly === true);
  if (directories === null) return scopeInputs(context, { kind: "tree" });
  return {
    directories: directories.map((directory) => [directory, fingerprint.entries[directory] ?? "absent"]),
    rootFiles: rootFiles(fingerprint.entries),
    ignored: fingerprint.ignored.filter(([path]) => underAny(path, directories)),
  };
}

function packageDirectories(context, directory, staticOnly) {
  const { root, fingerprint } = context;
  try {
    context.workspace ??= readWorkspace(root, fingerprint.entries);
    if (!context.workspace.has(directory)) return null;
    const closure = dependencyClosure(root, context.workspace, fingerprint.entries, directory);
    const cacheKeyPrefix = `${staticOnly ? "static" : "runtime"}:${closure.join(",")}:`;
    context.escapes ??= new Map();
    const escapes = closure.some((member) => {
      const escapeKey = `${cacheKeyPrefix}${member}`;
      if (!context.escapes.has(escapeKey)) {
        context.escapes.set(
          escapeKey,
          reachesOutsidePackage(root, fingerprint.entries, member, closure, { staticOnly }),
        );
      }
      return context.escapes.get(escapeKey);
    });
    return escapes ? null : closure;
  } catch {
    return null;
  }
}
