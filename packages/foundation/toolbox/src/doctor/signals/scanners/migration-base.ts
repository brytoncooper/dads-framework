/**
 * The base line migrations are frozen against, and what it already holds.
 *
 * A migration is a draft until it reaches the line databases are built from:
 * a branch may fix one as often as it likes, because no database has run it
 * yet. Once it is on that line, a change to it is a change to something a
 * database already did. So the history signals over migrations ask their
 * question of the commits this checkout has and the base does not, about the
 * migrations the base already holds.
 *
 * The base is the ref the caller named, else `origin/main`, else `main`. When
 * none resolves there is no line to draw, and the signals fall back to reading
 * the whole history — and say so in a note, because a fallback nobody hears
 * about reads as a measurement it is not.
 */

import type { DoctorContext } from "../../doctor-context.js";
import { runGit } from "./git-history.js";
import { isMigrationFile } from "./migration-files.js";

const DEFAULT_BASES = ["origin/main", "main"];

/** The base line, and what it holds: its commits and every migration on it. */
export type MigrationBase = {
  readonly ref: string;
  readonly commits: ReadonlySet<string>;
  readonly migrations: ReadonlySet<string>;
};

/** The note a signal leaves when there was no base to judge against. */
export const NO_BASE_NOTE = "no base ref (origin/main or main): every change after a migration's first commit counts";

function resolveBase(root: string, candidates: readonly string[]) {
  for (const ref of candidates) {
    const result = runGit(root, "rev-parse", ["--verify", "--quiet", `${ref}^{commit}`]);
    if (result.status === 0) return { ref, commit: result.stdout.trim() };
  }
  return undefined;
}

function listedLines(root: string, commandArguments: readonly string[]) {
  const listed = runGit(root, "log", commandArguments);
  return listed.status === 0 ? listed.stdout.split("\n").filter((line) => line.length > 0) : [];
}

/** The base this run judges migrations against, or nothing when none resolves. */
export function readMigrationBase(context: DoctorContext): MigrationBase | undefined {
  const candidates = context.base === undefined ? DEFAULT_BASES : [context.base];
  const base = resolveBase(context.root, candidates);
  if (base === undefined) return undefined;
  const commits = listedLines(context.root, ["--format=%H", base.commit]);
  const touched = listedLines(context.root, ["--format=", "--name-only", "--no-renames", base.commit]);
  return {
    ref: base.ref,
    commits: new Set(commits),
    migrations: new Set(touched.filter((path) => isMigrationFile(path))),
  };
}
