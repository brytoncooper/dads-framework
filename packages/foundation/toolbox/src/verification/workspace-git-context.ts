import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { environmentWithoutGitVariables } from "./git-environment.js";
import {
  readSnapshotGitEvidence,
  restoreSnapshotGitEvidence,
  type SnapshotGitEvidence,
} from "./workspace-git-evidence.js";

export type WorkspaceGitContext = {
  readonly head: string | undefined;
  readonly paths: readonly string[];
  readonly evidence: SnapshotGitEvidence;
};

export function copyWorkspaceFiles(projectRoot: string, root: string): void {
  cpSync(projectRoot, root, {
    recursive: true,
    dereference: false,
    // npm workspace links must resolve inside the verification copy.
    verbatimSymlinks: true,
    filter: (source) => {
      const pathFromRoot = relative(projectRoot, source);
      if (pathFromRoot === "") return true;
      const firstSegment = pathFromRoot.split(sep)[0];
      return firstSegment !== ".git" && firstSegment !== ".dads";
    },
  });
}

export function captureWorkspaceGitSnapshot(
  projectRoot: string,
  root: string,
  context: WorkspaceGitContext,
): void {
  const templateDirectory = mkdtempSync(
    join(tmpdir(), "dads-verification-git-template-"),
  );
  rmSync(root, { force: true, recursive: true });
  try {
    if (context.head) {
      runRequiredGit(
        projectRoot,
        ["clone", "--quiet", "--no-local", "--no-checkout", projectRoot, root],
        templateDirectory,
      );
      // Leave the local branch names available for the captured history bases.
      runRequiredGit(
        root,
        ["update-ref", "--no-deref", "HEAD", context.head],
        templateDirectory,
      );
      runRequiredGit(
        root,
        ["reset", "--mixed", "--quiet", context.head],
        templateDirectory,
      );
      runRequiredGit(
        root,
        ["config", "--local", "--remove-section", "remote.origin"],
        templateDirectory,
      );
      const copiedHead = runRequiredGit(
        root,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        templateDirectory,
      ).stdout.trim();
      if (copiedHead !== context.head) {
        throw new Error("Git snapshot HEAD differs from the captured HEAD.");
      }
    } else {
      mkdirSync(root, { recursive: true });
      runRequiredGit(
        root,
        ["init", "--quiet", "--template", templateDirectory],
        templateDirectory,
      );
    }

    copyWorkspaceFiles(projectRoot, root);
    synchronizeSnapshotInventory(root, context.paths, templateDirectory);
    restoreSnapshotGitEvidence(context.evidence, projectRoot, (args) => {
      runRequiredGit(root, args, templateDirectory);
    });
  } finally {
    rmSync(templateDirectory, { force: true, recursive: true });
  }
}

type GitResult = {
  readonly error: Error | undefined;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export function readWorkspaceGitContext(
  projectRoot: string,
): WorkspaceGitContext | undefined {
  const root = runSourceGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (root.error || root.status !== 0) {
    if (existsSync(join(projectRoot, ".git"))) {
      throw new Error("Git repository discovery failed for this workspace.");
    }
    return undefined;
  }

  const inventory = runSourceGit(projectRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (inventory.error || inventory.status !== 0) {
    throw new Error("Git source inventory could not be read.");
  }

  const head = runSourceGit(projectRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (head.error || head.status !== 0) assertUnbornHead(projectRoot);
  return {
    head:
      head.status === 0 && head.stdout.trim().length > 0
        ? head.stdout.trim()
        : undefined,
    evidence: readSnapshotGitEvidence((args) =>
      runSourceGit(projectRoot, args),
    ),
    paths: [
      ...new Set(
        inventory.stdout
          .split("\0")
          .filter(
            (path) =>
              path.length > 0 && path !== ".dads" && !path.startsWith(".dads/"),
          ),
      ),
    ],
  };
}

export function runGitCommand(
  projectRoot: string,
  argumentsAfterGit: readonly string[],
  options: {
    readonly input?: string | Buffer;
    readonly templateDirectory?: string;
    readonly sourceRead?: boolean;
  } = {},
): GitResult {
  const completed = spawnSync("git", argumentsAfterGit, {
    cwd: projectRoot,
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
    env: options.sourceRead
      ? sourceGitEnvironment()
      : sanitizedGitEnvironment(options.templateDirectory),
  });
  return {
    error: completed.error,
    status: completed.status,
    stdout: completed.error ? "" : completed.stdout,
    stderr: completed.error ? completed.error.message : completed.stderr,
  };
}

export function sanitizedGitEnvironment(
  templateDirectory?: string,
): NodeJS.ProcessEnv {
  const environment = sourceGitEnvironment();
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
  environment["GIT_CONFIG_SYSTEM"] = "/dev/null";
  if (templateDirectory) environment["GIT_TEMPLATE_DIR"] = templateDirectory;
  return environment;
}

/**
 * Which configuration files apply is the one thing a caller's `GIT_` variables
 * may still decide: these three name configuration, never a repository, and the
 * source inventory has to honour the user's global ignore rules to leave their
 * ignored files out of the snapshot.
 */
const configurationSelectors = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
];

function sourceGitEnvironment(): NodeJS.ProcessEnv {
  const environment = environmentWithoutGitVariables();
  for (const name of configurationSelectors) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Reads the source repository, returning the result; `read-changed-scope.ts` has `runGitForOutput`. */
function runSourceGit(
  projectRoot: string,
  argumentsAfterGit: readonly string[],
): GitResult {
  return runGitCommand(projectRoot, argumentsAfterGit, { sourceRead: true });
}

function assertUnbornHead(projectRoot: string): void {
  const symbolicHead = runSourceGit(projectRoot, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  if (!symbolicHead.error && symbolicHead.status === 0) {
    const branch = symbolicHead.stdout.trim();
    const ref = runSourceGit(projectRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      branch,
    ]);
    if (!ref.error && ref.status === 1) return;
  }
  throw new Error("Git HEAD is invalid; this is not an unborn repository.");
}

function synchronizeSnapshotInventory(
  root: string,
  paths: readonly string[],
  templateDirectory: string,
): void {
  const indexed = new Set(
    runRequiredGit(root, ["ls-files", "--cached", "-z"], templateDirectory)
      .stdout.split("\0")
      .filter((path) => path.length > 0),
  );
  const capturedPaths = new Set(paths);
  const removed = [...indexed].filter((path) => !capturedPaths.has(path));
  if (removed.length > 0) {
    runRequiredGit(
      root,
      ["update-index", "--force-remove", "-z", "--stdin"],
      templateDirectory,
      Buffer.from(`${removed.join("\0")}\0`),
    );
  }
  const missing = paths.filter(
    (path) =>
      !indexed.has(path) &&
      existsSync(join(root, path)) &&
      (lstatSync(join(root, path)).isFile() ||
        lstatSync(join(root, path)).isSymbolicLink()),
  );
  if (missing.length === 0) return;
  runRequiredGit(
    root,
    [
      "--literal-pathspecs",
      "add",
      "--intent-to-add",
      "--force",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ],
    templateDirectory,
    Buffer.from(`${missing.join("\0")}\0`),
  );
}

function runRequiredGit(
  cwd: string,
  argumentsAfterGit: readonly string[],
  templateDirectory: string,
  input?: string | Buffer,
): GitResult {
  const completed = runGitCommand(cwd, argumentsAfterGit, {
    ...(input === undefined ? {} : { input }),
    templateDirectory,
  });
  if (completed.error || completed.status !== 0) {
    const detail =
      completed.error?.message ||
      completed.stderr.trim() ||
      completed.stdout.trim() ||
      `status ${String(completed.status ?? "unknown")}`;
    throw new Error(`Git snapshot setup failed: ${detail}`);
  }
  return completed;
}
