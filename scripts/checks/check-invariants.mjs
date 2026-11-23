import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseInvariants } from "./check-invariants-grammar.mjs";
import {
  carriesSymbols,
  declaresSymbol,
  extensionOf,
  namesTest,
  readDeclaredSymbols,
  readTestNames,
} from "./check-invariants-symbols.mjs";

/**
 * Every `INVARIANTS.md` citation points at something that is still there.
 *
 * An invariant entry is a promise with a receipt: it names the code that
 * enforces the rule and the test that proves it. The receipt is worth exactly
 * as much as its accuracy, and nothing else in this repository reads it — a
 * renamed function or a deleted test leaves the entry behind, still confidently
 * naming a symbol that no longer exists. That is the failure `DAD.md` calls
 * gaslighting: a record that misrepresents, and reads as authoritative while it
 * does. Six agents each wrote a throwaway checker for their own package rather
 * than have one; this is the one.
 *
 * Three questions per citation, and nothing beyond them. Does the file exist?
 * Does the file declare the symbol? Does the file name the test? What the
 * entry *claims* is a human judgement and stays one — the gate holds the
 * citation, not the sentence in front of it.
 *
 * The grammar it parses is in `check-invariants-grammar.mjs`, derived from the
 * files rather than from a template. A bullet that does not parse fails and
 * names its file, its entry, and its text; nothing is skipped quietly.
 */

const INVARIANTS_FILE = "INVARIANTS.md";
const PACKAGE_ROOTS = ["packages", "apps", "fixtures"];
const NESTED_ROOTS = new Set(["packages"]);
const MISSING_FILE = "no such file";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Checks every citation in every `INVARIANTS.md` the workspace carries. An id
 * is also held unique across the whole workspace: two entries sharing one id
 * are two claims nobody can cite apart.
 */
export function checkInvariants(world) {
  const failures = [];
  const seenIds = new Map();
  let entryCount = 0;
  let citationCount = 0;

  const files = findInvariantsFiles(world);
  for (const file of files) {
    const owner = file.slice(0, -(INVARIANTS_FILE.length + 1));
    const parsed = parseInvariants(file, world.read(file));
    for (const problem of parsed.problems) {
      failures.push({ file, id: null, citation: null, problem });
    }
    entryCount += parsed.entries.length;
    for (const entry of parsed.entries) {
      citationCount += entry.citations.length;
      failures.push(...duplicateIdFailure(seenIds, file, entry.id));
      failures.push(...checkEntry(world, { file, owner, entry }));
    }
  }
  return { failures, files, entryCount, citationCount };
}

function duplicateIdFailure(seenIds, file, id) {
  const earlier = seenIds.get(id);
  seenIds.set(id, file);
  if (earlier === undefined) return [];
  return [
    {
      file,
      id,
      citation: null,
      problem: `duplicate id, already declared in ${earlier}`,
    },
  ];
}

/**
 * A missing file is reported once for the entry, not again for every symbol
 * and test name anchored to it: one absent path is one thing to fix.
 */
function checkEntry(world, { file, owner, entry }) {
  const failures = [];
  const missing = new Set();
  for (const citation of entry.citations) {
    if (missing.has(citation.path)) continue;
    const problem = checkCitation(world, owner, citation);
    if (problem === undefined) continue;
    if (problem === MISSING_FILE) missing.add(citation.path);
    failures.push({
      file,
      id: entry.id,
      citation: describeCitation(citation),
      problem,
    });
  }
  return failures;
}

/** The reason one citation does not resolve, or `undefined` when it does. */
function checkCitation(world, owner, citation) {
  const path = resolveCitedPath(world, owner, citation.path);
  if (path === undefined) return MISSING_FILE;
  if (citation.kind === "file") return undefined;
  if (!carriesSymbols(path)) {
    return `a .${extensionOf(path)} file declares no symbols`;
  }
  if (citation.kind === "symbol") {
    const declared = world.symbols(path);
    return declaresSymbol(declared, citation.symbol) ? undefined : `${path} declares no ${citation.symbol}`;
  }
  if (extensionOf(path) === "rs") {
    return `a Rust test is cited as ${path}#<fn>, not by a quoted name`;
  }
  return namesTest(world.tests(path), citation.name) ? undefined : `${path} names no such test`;
}

/**
 * A cited path is written relative to the package or relative to the
 * repository, and both forms appear in the same entry. The package is tried
 * first, so a package-local `src/plan.ts` never resolves to another one.
 */
function resolveCitedPath(world, owner, path) {
  const local = `${owner}/${path}`;
  if (world.exists(local)) return local;
  return world.exists(path) ? path : undefined;
}

function describeCitation(citation) {
  if (citation.kind === "test") return `\`${citation.path}\` "${citation.name}"`;
  if (citation.kind === "symbol") {
    return `\`${citation.path}#${citation.symbol}\``;
  }
  return `\`${citation.path}\``;
}

/** Every `INVARIANTS.md` under `packages/<group>/<name>`, `apps`, `fixtures`. */
export function findInvariantsFiles(world) {
  const files = [];
  for (const root of PACKAGE_ROOTS) {
    for (const directory of world.list(root)) {
      const owners = NESTED_ROOTS.has(root)
        ? world.list(`${root}/${directory}`).map((name) => `${directory}/${name}`)
        : [directory];
      for (const owner of owners) {
        const file = `${root}/${owner}/${INVARIANTS_FILE}`;
        if (world.exists(file)) files.push(file);
      }
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** JSON for machines, one line per failure for people. */
export function render(result, asJson) {
  const ok = result.failures.length === 0;
  if (asJson) {
    return `${JSON.stringify({
      ok,
      failures: result.failures,
      files: result.files.length,
      entries: result.entryCount,
      citations: result.citationCount,
    })}\n`;
  }

  const counts = `${result.entryCount} entries, ${result.citationCount} citations`;
  const lines = result.failures.map(renderFailure);
  lines.push(ok ? `invariants: ${counts}, ok` : `invariants: ${counts}, ${countLabel(result.failures.length)}`);
  return `${lines.join("\n")}\n`;
}

function renderFailure(failure) {
  const where = failure.id === null ? failure.file : `${failure.file} ${failure.id}`;
  const what = failure.citation === null ? "" : `${failure.citation}: `;
  return `${where}: ${what}${failure.problem}`;
}

function countLabel(count) {
  return `${count} ${count === 1 ? "failure" : "failures"}`;
}

/** The filesystem behind `world`, rooted at the repository, with two caches. */
export function createDiskWorld(root) {
  const symbols = new Map();
  const tests = new Map();
  const read = (path) => readFileSync(join(root, path), "utf8");
  const remember = (cache, path, build) => {
    const known = cache.get(path);
    if (known !== undefined) return known;
    const built = build(read(path), path);
    cache.set(path, built);
    return built;
  };
  return {
    exists: (path) => existsSync(join(root, path)),
    read,
    list: (directory) => listDirectories(root, directory),
    symbols: (path) => remember(symbols, path, readDeclaredSymbols),
    tests: (path) => remember(tests, path, readTestNames),
  };
}

function listDirectories(root, directory) {
  let entries;
  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
}

function resolveRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 || argv[index + 1] === undefined ? process.cwd() : resolve(argv[index + 1]);
}

export function main(argv) {
  const result = checkInvariants(createDiskWorld(resolveRoot(argv)));
  return {
    exitCode: result.failures.length > 0 ? 1 : 0,
    output: render(result, argv.includes("--json")),
  };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
