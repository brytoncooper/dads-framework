import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { findWorkspaceRoot } from "../start-test-postgres.js";

/**
 * Which checkout a test run belongs to.
 *
 * WHY THIS EXISTS. Every worktree of this repo shares one machine, one tmpdir
 * and one Docker daemon. A lease file named for the tier alone is therefore
 * shared by checkouts that have nothing to do with each other: worktree B
 * would attach to a template Postgres that worktree A migrated from a
 * different set of migrations, and see A's schema. Keying the file on the
 * worktree root makes that impossible without any coordination between them.
 *
 * The identity is a hash, not the path, because the path is long, contains
 * characters a filename should not, and is not secret enough to be worth
 * printing in tmpdir. The PATH is what a human needs in a message, so the
 * records that a human reads carry {@link currentWorktreePath} instead.
 */

/** The same 24-hex-character digest `check-edits.mjs` names its lock with. */
export function worktreeIdentity(realpath: string): string {
  return createHash("sha256").update(realpath).digest("hex").slice(0, 24);
}

/** The workspace root this process runs in, with every symlink resolved. */
export function currentWorktreePath(): string {
  return realpathSync(findWorkspaceRoot());
}

export function currentWorktreeIdentity(): string {
  return worktreeIdentity(currentWorktreePath());
}
