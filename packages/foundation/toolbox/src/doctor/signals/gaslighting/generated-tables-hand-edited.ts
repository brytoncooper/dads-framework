/**
 * Generated table modules edited by hand: ceiling 0.
 *
 * A table module that says `// GENERATED - DO NOT EDIT` on its first line is a
 * claim: this is what the migrations produce. Edit it by hand and the claim is
 * still there, now false. The code compiles against a table the database does
 * not have, and the next regeneration quietly takes the edit back.
 *
 * Each commit that added or changed such a module is read. It is authored when
 * the same commit changed a migration, because then the module is the
 * generator's answer to it. It is also allowed when the only difference from
 * the revision before is a `.$type<Brand>()` added or changed on a column that
 * already existed, plus the import that brand needs: the one fact about a
 * column the database cannot report, and the one the generator reads back.
 * Anything else counts once against the module.
 *
 * The modules asked about are the generated ones the tree holds now, each a
 * key with zeros included, so a clean module reads as measured rather than as
 * missing. Their history is read and nobody else's, which keeps the cost to
 * one revision lookup per change to a generated module rather than one per
 * change to any TypeScript file.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { isBrandOnlyEdit, isGeneratedTableModule } from "../scanners/generated-artifacts.js";
import {
  readCommitLog,
  readFileAtRevision,
  requireGitWorkspace,
  shortSha,
  type GitChange,
  type GitCommit,
} from "../scanners/git-history.js";
import { isMigrationFile } from "../scanners/migration-files.js";
import { addFinding } from "../scanners/typescript-program.js";

const TABLE_MODULE = ".ts";
const WRITTEN = new Set(["A", "M"]);
const MODIFIED = "M";

/** True when this change wrote a generated table module by hand. */
function isHandEdit(root: string, commit: GitCommit, change: GitChange): boolean {
  const after = readFileAtRevision(root, commit.sha, change.path);
  if (after === undefined || !isGeneratedTableModule(after)) return false;
  if (change.status !== MODIFIED) return true;
  const before = readFileAtRevision(root, `${commit.sha}^`, change.path);
  return before === undefined || !isBrandOnlyEdit(before, after);
}

function handEdits(root: string, commits: readonly GitCommit[], readings: Map<string, SignalReading>): void {
  for (const commit of commits) {
    if (commit.changes.some((change) => isMigrationFile(change.path))) continue;
    for (const change of commit.changes) {
      if (!WRITTEN.has(change.status)) continue;
      if (!readings.has(change.path)) continue;
      if (!isHandEdit(root, commit, change)) continue;
      addFinding(readings, change.path, {
        path: change.path,
        name: `${shortSha(commit.sha)} ${commit.message}`,
      });
    }
  }
}

function countHandEditedTables(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!path.endsWith(TABLE_MODULE) || !context.exists(path)) continue;
    if (!isGeneratedTableModule(context.read(path))) continue;
    readings.set(path, { value: 0, evidence: [] });
  }
  handEdits(context.root, readCommitLog(context.root), readings);
  return readings;
}

export const generatedTablesHandEditedSignal: DoctorSignal = {
  id: "generated-tables-hand-edited",
  issue: "gaslighting",
  question: "Was a generated table module changed in a commit that changed no migration, beyond a brand annotation?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "That’s not a public contract. That’s just how the table looks.",
  run: (context) => Promise.resolve(countHandEditedTables(context)),
};
