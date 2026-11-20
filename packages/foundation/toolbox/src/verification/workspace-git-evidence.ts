import { posix } from "node:path";

/** Local inputs used by Git history and hook checks inside a frozen checkout. */
export type SnapshotGitEvidence = {
  readonly historyBases: readonly { ref: string; commit: string }[];
  readonly hooksPath?: string;
};

const historyRefs = ["refs/remotes/origin/main", "refs/heads/main"];

type ReadGit = (args: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
};

export function readSnapshotGitEvidence(read: ReadGit): SnapshotGitEvidence {
  const historyBases = historyRefs.flatMap((ref) => {
    const result = read([
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    const commit = result.stdout.trim();
    return result.status === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
      ? [{ ref, commit }]
      : [];
  });
  const hooks = read(["config", "--get", "core.hooksPath"]);
  const hooksPath = hooks.stdout.trim();
  const isPortable =
    hooks.status === 0 &&
    hooksPath.length > 0 &&
    !posix.isAbsolute(hooksPath) &&
    !/^[a-z]:/i.test(hooksPath) &&
    !hooksPath.includes("\\") &&
    posix.normalize(hooksPath) === hooksPath &&
    !hooksPath.split("/").some((part) => [".", "..", ".git"].includes(part));
  return { historyBases, ...(isPortable ? { hooksPath } : {}) };
}

export function restoreSnapshotGitEvidence(
  evidence: SnapshotGitEvidence,
  sourceRoot: string,
  run: (args: readonly string[]) => void,
): void {
  if (evidence.historyBases.length > 0) {
    // Fetch exact objects from the local checkout. This installs no remote.
    run([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      sourceRoot,
      ...evidence.historyBases.map(({ ref, commit }) => `+${commit}:${ref}`),
    ]);
  }
  // Configure hooks only after finishing every snapshot Git write.
  if (evidence.hooksPath !== undefined) {
    run(["config", "--local", "core.hooksPath", evidence.hooksPath]);
  }
}
