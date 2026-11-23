/**
 * Migrations whose order a database cannot trust: ceiling 0.
 *
 * Two branches start from the same journal, each picks "the next stamp", and
 * whichever merges second lands a migration older than one a database has
 * already run. A runner that orders by stamp then skips it, or runs it out of
 * order, and nobody can say afterwards which version of the schema shipped.
 *
 * A migration answers in one of two ways, and each is asked its own question.
 *
 * One that leaves its order to its stamp is read against the base line — the
 * ref the caller named, else `origin/main`, else `main`: a migration this
 * checkout adds past the base must be stamped later than every migration the
 * base holds in its directory. What the base already holds was judged when it
 * landed, and migrations added together on a branch are not ordered against
 * each other. With no base, the whole history is read instead — each
 * migration against what its directory held when the commit adding it landed
 * — and the signal leaves a note saying so.
 *
 * One that states its order with `dependsOn` is read against the tree, and
 * owes three things: a list the runner can read, every name on it a migration
 * that exists, and no cycle through it. Its stamp is then only a name, so it
 * is not asked the first question.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { addFinding } from "../scanners/typescript-program.js";
import { readCommitLog, requireGitWorkspace, shortSha, type GitCommit } from "../scanners/git-history.js";
import { NO_BASE_NOTE, readMigrationBase, type MigrationBase } from "../scanners/migration-base.js";
import {
  isMigrationFile,
  migrationJournal,
  migrationName,
  migrationStamp,
  readPrerequisites,
  type MigrationPrerequisites,
} from "../scanners/migration-files.js";

const ADDED = "A";

type MigrationTree = ReadonlyMap<string, MigrationPrerequisites>;

/** Every migration in the tree, by path, with how it declares its order. */
function readMigrationTree(context: DoctorContext): MigrationTree {
  const tree = new Map<string, MigrationPrerequisites>();
  for (const path of context.files()) {
    if (!isMigrationFile(path) || !context.exists(path)) continue;
    tree.set(path, readPrerequisites(path, context.read(path)));
  }
  return tree;
}

type Readings = Map<string, SignalReading>;

function newerThanAll(newest: Map<string, string>, paths: readonly string[]): void {
  for (const path of paths) {
    const journal = migrationJournal(path);
    const stamp = migrationStamp(path);
    if (stamp > (newest.get(journal) ?? "")) newest.set(journal, stamp);
  }
}

function judgeAddition(
  readings: Readings,
  tree: MigrationTree,
  path: string,
  addition: { readonly before: string; readonly name: string },
): void {
  if (tree.get(path)?.kind !== "stamp") return;
  if (migrationStamp(path) > addition.before) return;
  addFinding(readings, path, {
    path,
    name: `${addition.name} added after ${addition.before}`,
  });
}

function addedMigrations(commit: GitCommit): readonly string[] {
  return commit.changes
    .filter((change) => change.status === ADDED && isMigrationFile(change.path))
    .map((change) => change.path);
}

/** Stamp-ordered migrations past the base, against the base's newest. */
function stampsPastBase(
  commits: readonly GitCommit[],
  base: MigrationBase,
  tree: MigrationTree,
  readings: Readings,
): void {
  const newest = new Map<string, string>();
  newerThanAll(newest, [...base.migrations]);
  for (const commit of commits) {
    if (base.commits.has(commit.sha)) continue;
    for (const path of addedMigrations(commit)) {
      const before = newest.get(migrationJournal(path)) ?? "";
      judgeAddition(readings, tree, path, {
        before,
        name: shortSha(commit.sha),
      });
    }
  }
}

/** With no base: each addition against what its journal held when it landed. */
function stampsInHistory(commits: readonly GitCommit[], tree: MigrationTree, readings: Readings): void {
  const newest = new Map<string, string>();
  for (const commit of [...commits].reverse()) {
    const added = addedMigrations(commit);
    for (const path of added) {
      const before = newest.get(migrationJournal(path)) ?? "";
      judgeAddition(readings, tree, path, {
        before,
        name: shortSha(commit.sha),
      });
    }
    newerThanAll(newest, added);
  }
}

function stampsOutOfOrder(context: DoctorContext, tree: MigrationTree, readings: Readings): void {
  const commits = readCommitLog(context.root);
  const base = readMigrationBase(context);
  if (base !== undefined) {
    stampsPastBase(commits, base, tree, readings);
    return;
  }
  context.notes?.push(NO_BASE_NOTE);
  stampsInHistory(commits, tree, readings);
}

/** True when following a migration's prerequisites leads back to it. */
function reachesItself(start: string, graph: ReadonlyMap<string, readonly string[]>): boolean {
  const seen = new Set<string>();
  const queue = [...(graph.get(start) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(graph.get(next) ?? []));
  }
  return false;
}

/** The problems one migration's stated prerequisites have, in words. */
function prerequisiteProblems(path: string, graph: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const problems = (graph.get(migrationName(path)) ?? [])
    .filter((name) => !graph.has(name))
    .map((name) => `missing prerequisite ${name}`);
  return reachesItself(migrationName(path), graph) ? [...problems, "prerequisite cycle"] : problems;
}

function declaredGraph(tree: MigrationTree): Map<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  for (const [path, prerequisites] of tree) {
    graph.set(migrationName(path), prerequisites.kind === "graph" ? prerequisites.dependencies : []);
  }
  return graph;
}

/** Stated orders the runner cannot read, cannot satisfy, or cannot finish. */
function graphProblems(tree: MigrationTree, readings: Map<string, SignalReading>): void {
  const graph = declaredGraph(tree);
  for (const [path, prerequisites] of tree) {
    const problems: SignalEvidence[] =
      prerequisites.kind === "invalid"
        ? [{ path, name: "dependsOn is not an exported literal list" }]
        : prerequisiteProblems(path, graph).map((name) => ({ path, name }));
    for (const evidence of problems) addFinding(readings, path, evidence);
  }
}

function countOutOfOrder(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const tree = readMigrationTree(context);
  const readings = new Map<string, SignalReading>([...tree.keys()].map((path) => [path, { value: 0, evidence: [] }]));
  stampsOutOfOrder(context, tree, readings);
  graphProblems(tree, readings);
  return readings;
}

export const migrationsOutOfOrderSignal: DoctorSignal = {
  id: "migrations-out-of-order",
  issue: "disorganized-attachment",
  question:
    "Is a migration added past the base stamped older than its journal's newest on the base, or does one state prerequisites the runner cannot satisfy?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Sometimes you wake up to a production incident and cannot remember which version of you shipped.",
  run: (context) => Promise.resolve(countOutOfOrder(context)),
};
