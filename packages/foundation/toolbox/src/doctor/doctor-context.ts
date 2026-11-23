/**
 * The world one `dad doctor` run is allowed to see.
 *
 * Every expensive input is built once and only when a selected signal asks for
 * it: the file list, the package graph, and the parsed TypeScript program.
 * Signals that only read text therefore cost nothing beyond the files they
 * open, which is what lets a repository with no TypeScript in it still get a
 * report.
 *
 * Nothing here reads the clock. `today` arrives from `--today` or it is
 * `undefined`, and a signal that needs a date and does not have one reports
 * that it was not measured rather than inventing one. Two runs over the same
 * tree with the same arguments therefore print the same bytes.
 *
 * The file list is the tracked files when the root is the top of a git
 * repository, and a walk otherwise, so the doctor works on a directory that
 * was never committed. Either way it excludes what nobody hand-wrote:
 * `node_modules`, build output, and `*.generated.ts`.
 *
 * The network is injected and never assumed. A run is offline unless the
 * caller said otherwise, `fetch` refuses before it reaches anything when it is,
 * and the signals that need a registry or a forge report that they were not
 * measured rather than counting a zero nobody measured.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord, isString, isUnknownArray } from "../parse-guards.js";
import { environmentWithoutGitVariables } from "../verification/git-environment.js";
import { buildTypeScriptProgram, type DoctorProgram } from "./signals/scanners/typescript-program.js";

const PROJECT_FILE = "dads.project.json";
const PACKAGE_MANIFEST = "package.json";
const GENERATED_SUFFIX = ".generated.ts";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "target"]);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** One package as its project declaration describes it. */
export type DoctorPackage = {
  readonly name: string;
  readonly root: string;
  readonly kind: string | undefined;
  readonly allowedDependencies: readonly string[];
};

/** What a command wrote and how it ended. */
export type DoctorCommandResult = {
  readonly status: number;
  readonly stdout: string;
};

/** What one request answered: the status it came back with, and its body. */
export type DoctorHttpResponse = {
  readonly status: number;
  readonly body: string;
};

/**
 * The transport one request goes over: the global `fetch` in a real run, and
 * whatever a test hands the context otherwise. It is handed the deadline this
 * module decided, so no implementation can quietly drop it.
 */
export type DoctorFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export type DoctorContext = {
  /** Absolute path of the repository being diagnosed. */
  readonly root: string;
  /** The date `--today` supplied, or `undefined`. Never read from a clock. */
  readonly today: string | undefined;
  /** Repository-relative paths of every hand-written tracked file. */
  files(): readonly string[];
  /**
   * Names of the hand-written directories directly inside a repository-relative
   * path, sorted, and empty when the path is not a directory. This is the seam
   * for a signal whose subject is a directory that exists rather than a file
   * git has been told about — a fixture corpus is one from the moment somebody
   * writes it, and a floor that only counts committed cases would let an
   * uncommitted one look like a case that was never written.
   */
  directories(path: string): readonly string[];
  /** UTF-8 contents of a repository-relative path, read once per run. */
  read(path: string): string;
  /** True when a repository-relative path exists on disk. */
  exists(path: string): boolean;
  /** The declared packages, or the workspace manifests when none are declared. */
  packages(): readonly DoctorPackage[];
  /** The seam for a signal that cannot answer from the file tree. */
  exec(command: string, commandArguments: readonly string[]): DoctorCommandResult;
  /**
   * Whether this run was told it may reach the network. False unless the
   * caller said `--online`, so nothing reaches out by default and a report is
   * the same offline as it is on a train.
   */
  readonly online: boolean;
  /**
   * One GET, with a deadline and no retry. It throws the offline failure when
   * the run is not online, so a signal cannot reach the network by forgetting
   * to ask whether it may.
   */
  fetch(url: string): Promise<DoctorHttpResponse>;
  /**
   * The workspace's modules, parsed once by the compiler. Built the first time
   * a signal asks and never otherwise, so a repository with no TypeScript in
   * it still gets a report out of the signals that could answer. It throws
   * when the workspace declares no TypeScript project, and the signal runner
   * turns that into `not measured` with the reason.
   */
  program(): DoctorProgram;
  /**
   * The ref a signal that judges history against a base line reads, when the
   * caller named one. Without it such a signal looks for `origin/main`, then
   * `main`, and says so when it finds neither.
   */
  readonly base?: string | undefined;
  /**
   * Where a signal writes what a reader needs to know about how it answered —
   * a fallback it took, a narrower question it asked — beside the number. The
   * runner hands each signal's notes back on its outcome. Optional, so a
   * context written by hand in a test needs none.
   */
  readonly notes?: string[];
};

export type DoctorContextInput = {
  readonly root: string;
  readonly today?: string | undefined;
  /**
   * The file list every signal sees, when the caller has already decided it.
   * The gate is the caller that does: `--file` narrows a run to one path, and
   * a baseline's `exempt` globs take paths out of every reading, so the
   * narrowing has to happen before the first signal — and before the
   * TypeScript program, which is built from this list — rather than after.
   */
  readonly files?: readonly string[] | undefined;
  readonly exec?: ((command: string, commandArguments: readonly string[]) => DoctorCommandResult) | undefined;
  /** Whether the run may reach the network at all. Default false. */
  readonly online?: boolean | undefined;
  /** The transport the requests go over. Default the global `fetch`. */
  readonly fetch?: DoctorFetch | undefined;
  /** The base ref history signals judge against; see `DoctorContext.base`. */
  readonly base?: string | undefined;
};

/** Builds the context for one run. Nothing is read until a signal asks. */
export function createDoctorContext(input: DoctorContextInput): DoctorContext {
  const root = resolve(input.root);
  const contents = new Map<string, string>();
  let fileList: readonly string[] | undefined;
  let packageList: readonly DoctorPackage[] | undefined;
  let program: DoctorProgram | undefined;

  const context: DoctorContext = {
    root,
    today: input.today,
    files: () => (fileList ??= input.files ?? listHandWrittenFiles(root)),
    directories: (path) => listHandWrittenDirectories(join(root, path)),
    read: (path) => {
      const known = contents.get(path);
      if (known !== undefined) return known;
      const text = readFileSync(join(root, path), "utf8");
      contents.set(path, text);
      return text;
    },
    exists: (path) => existsSync(join(root, path)),
    packages: () => (packageList ??= readDeclaredPackages(context)),
    exec: input.exec ?? ((command, args) => runCommand(root, command, args)),
    online: input.online ?? false,
    fetch: (url) => requestOnce(input, url),
    program: () => (program ??= buildTypeScriptProgram(context)),
    base: input.base,
    notes: [],
  };
  return context;
}

// ---------------------------------------------------------------------------
// The file list
// ---------------------------------------------------------------------------

/**
 * True for a file somebody typed. Build output and generated modules are not
 * hand-written source, and no question in `docs/daddy-issues.md` is asked of
 * them: "any occurrence outside generated files is a yes" is how the companion
 * words it, and a source-budget baseline exempts the same paths.
 */
export function isHandWritten(path: string): boolean {
  if (path.endsWith(GENERATED_SUFFIX)) return false;
  return !path.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

function isHidden(segment: string): boolean {
  return segment.startsWith(".");
}

function listHandWrittenFiles(root: string): readonly string[] {
  const listed = isGitWorktree(root) ? listGitWorktreeFiles(root) : walkFiles(root, "");
  return listed.filter(isHandWritten);
}

/**
 * The directories directly inside `path`, minus the ones nobody hand-wrote and
 * the hidden ones. A path that is not a directory has none, which is how a
 * signal asks whether a corpus is there at all.
 */
function listHandWrittenDirectories(path: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !isHidden(entry.name) && !SKIPPED_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** True when `root` is the top of or inside a git worktree. */
function isGitWorktree(root: string): boolean {
  const shown = runDoctorGit(root, ["rev-parse", "--show-toplevel"]);
  return shown.status === 0 && shown.stdout.trim().length > 0;
}

function listGitWorktreeFiles(root: string): readonly string[] {
  const listed = runDoctorGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed.status !== 0) return walkFiles(root, "");
  return listed.stdout.split("\0").filter((path) => path.length > 0 && existsSync(join(root, path)));
}

function runDoctorGit(root: string, commandArguments: readonly string[]): DoctorCommandResult {
  const finished = spawnSync("git", [...commandArguments], {
    cwd: root,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { status: finished.status ?? 1, stdout: finished.stdout };
}

function walkFiles(root: string, prefix: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    if (SKIPPED_DIRECTORIES.has(entry.name) || isHidden(entry.name)) continue;
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkFiles(root, path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The package graph
// ---------------------------------------------------------------------------

/**
 * The declared packages when `dads.project.json` is there, and every workspace
 * `package.json` otherwise. A repository that has not adopted Dads still has
 * packages, and the signals that read them still have something to read.
 */
function readDeclaredPackages(context: DoctorContext): readonly DoctorPackage[] {
  if (!context.exists(PROJECT_FILE)) return readManifestPackages(context);
  const parsed: unknown = JSON.parse(context.read(PROJECT_FILE));
  if (!isRecord(parsed)) return [];
  const declared: unknown = parsed["packages"];
  if (!isUnknownArray(declared)) return [];
  return declared.flatMap((entry) => toDeclaredPackage(entry));
}

function toDeclaredPackage(entry: unknown): readonly DoctorPackage[] {
  if (!isRecord(entry)) return [];
  const name: unknown = entry["name"];
  const root: unknown = entry["root"];
  if (!isString(name) || !isString(root)) return [];
  const kind: unknown = entry["kind"];
  return [
    {
      name,
      root,
      kind: isString(kind) ? kind : undefined,
      allowedDependencies: readDeclaredStrings(entry["allowedDependencies"]),
    },
  ];
}

function readDeclaredStrings(value: unknown): readonly string[] {
  return isUnknownArray(value) ? value.filter(isString) : [];
}

function readManifestPackages(context: DoctorContext): readonly DoctorPackage[] {
  const found: DoctorPackage[] = [];
  for (const path of context.files()) {
    if (!path.endsWith(PACKAGE_MANIFEST)) continue;
    const root = path.slice(0, path.length - PACKAGE_MANIFEST.length);
    if (root.length > 0 && !root.endsWith("/")) continue;
    const name = readManifestName(context, path);
    if (name === undefined) continue;
    found.push({
      name,
      root: root.replace(/\/$/, ""),
      kind: undefined,
      allowedDependencies: [],
    });
  }
  return found;
}

function readManifestName(context: DoctorContext, path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(context.read(path));
    if (!isRecord(parsed)) return undefined;
    const name: unknown = parsed["name"];
    return isString(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

function runCommand(root: string, command: string, commandArguments: readonly string[]): DoctorCommandResult {
  const finished = spawnSync(command, [...commandArguments], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { status: finished.status ?? 1, stdout: finished.stdout };
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

/** How long one request may take before it is abandoned. Nothing retries. */
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;

/** The failure every online signal reports when the run may not reach out. */
export const NOT_MEASURED_OFFLINE = "not measured (offline)";

/**
 * One GET, and only ever one: it carries a deadline, it is never retried, and
 * nothing here writes. The body comes back as text, so this module never
 * decides what a response means — the signal that asked names every field it
 * reads, and a sentence in a body is data rather than an instruction.
 */
async function requestOnce(input: DoctorContextInput, url: string): Promise<DoctorHttpResponse> {
  if (input.online !== true) throw new Error(NOT_MEASURED_OFFLINE);
  const transport = input.fetch ?? globalThis.fetch;
  const answered = await transport(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  return { status: answered.status, body: await answered.text() };
}
