/**
 * Authority living in a person: report-only, in both profiles.
 *
 * This one is a heuristic and says so. It cannot see who decides things; it can
 * only see the shape a codebase takes when nobody wrote the rules down and one
 * person is the only place they exist. A package with no recorded invariants
 * where a single author holds more than four commits in five is that shape:
 * every question about it has one correct answer and only one person has it.
 *
 * Two guards keep it from being noise. A package that records its invariants is
 * not measured at all — the rules are in a file, which is the cure, and who
 * wrote them stops mattering. And a package with fewer than ten commits is
 * reported at zero, because a share computed from a handful of commits says
 * nothing: one author holding three commits out of three is a new package, not
 * a scripture.
 *
 * It is report-only in both profiles for the reason the companion gives. There
 * is no number of commits by one person that is a violation, and a rule that
 * fires on a fact nobody can argue with is the helicopter dad the essay warns
 * about. It names a smell and hands the reader the name of the person to ask.
 */

import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  readCommitLog,
  requireGitWorkspace,
  type GitCommit,
} from "../scanners/git-history.js";

const INVARIANTS_FILE = "INVARIANTS.md";
const CONCENTRATION_PERCENT = 80;
const MINIMUM_COMMITS = 10;
const WHOLE = 100;

type AuthorCounts = ReadonlyMap<string, number>;

/** The longest declared root that contains the path, so nesting resolves. */
function packageOwningPath(
  path: string,
  roots: readonly string[],
): string | undefined {
  let owner: string | undefined;
  for (const root of roots) {
    if (!path.startsWith(`${root}/`)) continue;
    if (owner === undefined || root.length > owner.length) owner = root;
  }
  return owner;
}

/** One commit counts once per package it touched, whatever it touched there. */
function countAuthorsPerPackage(
  commits: readonly GitCommit[],
  roots: readonly string[],
): ReadonlyMap<string, AuthorCounts> {
  const counted = new Map<string, Map<string, number>>();
  for (const commit of commits) {
    const touched = new Set(
      commit.changes.flatMap((change) => {
        const owner = packageOwningPath(change.path, roots);
        return owner === undefined ? [] : [owner];
      }),
    );
    for (const root of touched) {
      const authors = counted.get(root) ?? new Map<string, number>();
      authors.set(
        commit.authorEmail,
        (authors.get(commit.authorEmail) ?? 0) + 1,
      );
      counted.set(root, authors);
    }
  }
  return counted;
}

type LeadingAuthor = {
  readonly email: string;
  readonly commits: number;
  readonly total: number;
};

function leadingAuthor(authors: AuthorCounts): LeadingAuthor | undefined {
  let leader: LeadingAuthor | undefined;
  let total = 0;
  for (const [email, commits] of authors) {
    total += commits;
    if (leader === undefined || commits > leader.commits) {
      leader = { email, commits, total: 0 };
    }
  }
  return leader === undefined ? undefined : { ...leader, total };
}

function readOnePackage(
  declared: DoctorPackage,
  authors: AuthorCounts,
): SignalReading | undefined {
  const leader = leadingAuthor(authors);
  if (leader === undefined) return undefined;
  const share = Math.round((leader.commits * WHOLE) / leader.total);
  const concentrated =
    leader.total >= MINIMUM_COMMITS && share > CONCENTRATION_PERCENT;
  return {
    value: concentrated ? share : 0,
    evidence: [
      {
        path: `${declared.root}/${INVARIANTS_FILE}`,
        name: `${leader.email}, ${leader.commits} of ${leader.total} commits`,
      },
    ],
  };
}

function measureAuthorConcentration(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const measured = context
    .packages()
    .filter(
      (declared) =>
        declared.root.length > 0 &&
        !context.exists(`${declared.root}/${INVARIANTS_FILE}`),
    );
  const roots = measured.map((declared) => declared.root);
  const counted = countAuthorsPerPackage(readCommitLog(context.root), roots);
  const readings = new Map<string, SignalReading>();
  for (const declared of measured) {
    const authors = counted.get(declared.root);
    const reading =
      authors === undefined ? undefined : readOnePackage(declared, authors);
    if (reading !== undefined) readings.set(declared.name, reading);
  }
  return readings;
}

export const scriptureSignal: DoctorSignal = {
  id: "scripture",
  issue: "you-are-looking-for-a-father-figure",
  question:
    "Does a package with no recorded invariants have one author holding more than 80% of its commits? (heuristic)",
  reads: "git",
  unit: "percent",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence: "You let the last senior’s PR become scripture.",
  run: (context) => Promise.resolve(measureAuthorConcentration(context)),
};
