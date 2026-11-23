/**
 * Migrations rewritten after they were committed: ceiling 0.
 *
 * A migration is a record of something a database already did. Once it is
 * committed, some database somewhere has run it, and that database will never
 * run it again: editing the file changes the story the repository tells
 * without changing what happened. A fresh database and an old one then
 * disagree about the schema, and the file says they cannot. The cure is a new
 * migration, never an edit to an old one.
 *
 * A migration is frozen once it reaches the base line — the ref the caller
 * named, else `origin/main`, else `main` — because that is the line databases
 * are built from. Before that it is a draft, and a branch may fix it as often
 * as it likes: nothing has run it yet. So the reading is every commit this
 * checkout has and the base does not that modified, deleted, or renamed away a
 * migration the base already holds, counted once against that migration.
 * Drafts read zero, and so does a checkout sitting on the base itself: what
 * the base already holds is history the gate judged when it landed.
 *
 * Renames are read as a delete and an add, so a moved migration counts too: a
 * runner that keys on the file name sees a migration it has never run and one
 * it can no longer find.
 *
 * With no base to draw the line, the reading falls back to the whole history —
 * every change after the commit that added a migration counts — and the signal
 * leaves a note saying so, so a repository with no `main` is not told its
 * migrations were judged against one.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReadings } from "../../doctor-signal.js";
import {
  readCommitLog,
  requireGitWorkspace,
  shortSha,
  type GitChange,
  type GitCommit,
} from "../scanners/git-history.js";
import { NO_BASE_NOTE, readMigrationBase, type MigrationBase } from "../scanners/migration-base.js";
import { isMigrationFile } from "../scanners/migration-files.js";

const ADDED = "A";

/**
 * Records one change to a migration: the first add opens its record, and
 * every change after that is an edit.
 */
function recordChange(edits: Map<string, SignalEvidence[]>, commit: GitCommit, change: GitChange): void {
  const found = edits.get(change.path);
  if (found === undefined && change.status === ADDED) {
    edits.set(change.path, []);
    return;
  }
  const evidence = found ?? [];
  evidence.push(editEvidence(commit, change));
  edits.set(change.path, evidence);
}

function editEvidence(commit: GitCommit, change: GitChange): SignalEvidence {
  return {
    path: change.path,
    name: `${shortSha(commit.sha)} ${change.status} ${commit.message}`,
  };
}

/** With no base: every edit to a migration after it was added. */
function editsByMigration(commits: readonly GitCommit[]): ReadonlyMap<string, readonly SignalEvidence[]> {
  const edits = new Map<string, SignalEvidence[]>();
  for (const commit of [...commits].reverse()) {
    for (const change of commit.changes) {
      if (isMigrationFile(change.path)) recordChange(edits, commit, change);
    }
  }
  return edits;
}

/** Changes past the base to migrations the base already holds. */
function editsPastBase(
  commits: readonly GitCommit[],
  base: MigrationBase,
): ReadonlyMap<string, readonly SignalEvidence[]> {
  const edits = new Map<string, SignalEvidence[]>();
  for (const commit of commits) {
    for (const change of commit.changes) {
      if (!isMigrationFile(change.path)) continue;
      const found = edits.get(change.path) ?? [];
      edits.set(change.path, found);
      if (base.commits.has(commit.sha)) continue;
      if (!base.migrations.has(change.path)) continue;
      found.push(editEvidence(commit, change));
    }
  }
  return edits;
}

function countMigrationEdits(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const commits = readCommitLog(context.root);
  const base = readMigrationBase(context);
  if (base === undefined) context.notes?.push(NO_BASE_NOTE);
  const edits = base === undefined ? editsByMigration(commits) : editsPastBase(commits, base);
  return new Map([...edits].map(([path, evidence]) => [path, { value: evidence.length, evidence }]));
}

export const migrationsEditedSignal: DoctorSignal = {
  id: "migrations-edited",
  issue: "gaslighting",
  question: "Was a migration the base line already holds modified, deleted, or renamed by a commit past the base?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "First you rename the violation. Then you explain why it had to happen.",
  run: (context) => Promise.resolve(countMigrationEdits(context)),
};
