import { createHash, type Hash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  captureWorkspaceGitSnapshot,
  copyWorkspaceFiles,
  readWorkspaceGitContext,
  type WorkspaceGitContext,
} from "./workspace-git-context.js";

export type VerificationWorkspaceSnapshot = {
  readonly root: string;
  readonly identity: string;
  readonly gitEvidenceIdentity?: string;
};

export function readWorkspaceIdentity(projectRoot: string): string {
  const gitContext = readWorkspaceGitContext(projectRoot);
  const paths = gitContext?.paths ?? readFilesystemPaths(projectRoot);
  assertWorkspaceSymlinksStayInsideRoot(projectRoot, paths);
  const hash = createHash("sha256");
  hashGitContext(hash, gitContext, paths.length);
  for (const projectPath of [...paths].sort()) {
    const absolutePath = join(projectRoot, projectPath);
    const status = readOptionalStatus(absolutePath);
    if (!status) {
      hash.update(`${projectPath}\0missing\0`);
      continue;
    }
    const contents = status.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolutePath))
      : readFileSync(absolutePath);
    hash.update(
      `${projectPath}\0${status.isSymbolicLink() ? "link" : "file"}\0`,
    );
    hash.update(contents);
  }
  return hash.digest("hex");
}

function hashGitContext(
  hash: Hash,
  context: WorkspaceGitContext | undefined,
  paths: number,
): void {
  hash.update(`git-context\0${context ? "repository" : "filesystem"}\0`);
  hash.update(`git-head\0${context?.head ?? "unborn-or-no-head"}\0`);
  hash.update(`git-evidence\0${JSON.stringify(context?.evidence ?? null)}\0`);
  hash.update(`git-inventory\0${paths}\0`);
}

export function captureWorkspaceSnapshot(
  projectRoot: string,
  expectedIdentity: string,
): VerificationWorkspaceSnapshot {
  const identity = readWorkspaceIdentity(projectRoot);
  if (identity !== expectedIdentity) {
    throw new Error(
      "Checkout identity changed between planning and verification.",
    );
  }
  const root = mkdtempSync(join(tmpdir(), "dads-verification-graph-"));
  try {
    const gitContext = readWorkspaceGitContext(projectRoot);
    if (gitContext) {
      captureWorkspaceGitSnapshot(projectRoot, root, gitContext);
    } else {
      copyWorkspaceFiles(projectRoot, root);
    }
    if (readWorkspaceIdentity(projectRoot) !== expectedIdentity) {
      throw new Error(
        "Checkout identity changed while the graph snapshot was captured.",
      );
    }
    const gitEvidenceIdentity = gitContext
      ? createHash("sha256")
          .update(JSON.stringify(gitContext.evidence))
          .digest("hex")
      : undefined;
    return {
      root,
      identity,
      ...(gitEvidenceIdentity === undefined ? {} : { gitEvidenceIdentity }),
    };
  } catch (error: unknown) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function assertWorkspaceSymlinksStayInsideRoot(
  projectRoot: string,
  projectPaths: readonly string[],
): void {
  const canonicalRoot = realpathSync(projectRoot);
  for (const projectPath of projectPaths) {
    const absolutePath = join(projectRoot, projectPath);
    const status = readOptionalStatus(absolutePath);
    if (!status || !status.isSymbolicLink()) continue;
    const linkTarget = readlinkSync(absolutePath);
    if (isAbsolute(linkTarget)) {
      throw new Error(
        `Workspace symlink points outside the captured workspace: ${projectPath}.`,
      );
    }
    const canonicalTarget = realpathSync(absolutePath);
    const pathFromRoot = relative(canonicalRoot, canonicalTarget);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
      throw new Error(
        `Workspace symlink points outside the captured workspace: ${projectPath}.`,
      );
    }
  }
}

function readOptionalStatus(
  path: string,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export function discardWorkspaceSnapshot(
  snapshot: VerificationWorkspaceSnapshot,
): void {
  rmSync(snapshot.root, { force: true, recursive: true });
}

function readFilesystemPaths(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".dads", "node_modules"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readFilesystemPaths(root, path);
    if (!entry.isFile() && !entry.isSymbolicLink()) return [];
    return [relative(root, path).split(sep).join("/")];
  });
}
