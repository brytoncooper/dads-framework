import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  defaultMigrationWorkspace,
  discoverDomainMigrations,
  type MigrationWorkspace,
  planMigrationOrder,
} from "../index.js";

/** Owner-approved edits to migrations that never ran anywhere deployed. */
const APPROVED_UNDEPLOYED_EDITS = "migrations/approved-undeployed-edits.json";

function isMigrationFile(workspace: MigrationWorkspace, file: string): boolean {
  return workspace.sources.some((source) => source.files.test(file));
}

const approvedEditSchema = z.object({
  edits: z.array(z.object({ file: z.string(), sha256: z.string() })),
  deletions: z.array(z.object({ file: z.string() })).default([]),
});

async function readApprovedUndeployedChanges(
  workspaceRoot: string,
): Promise<z.infer<typeof approvedEditSchema>> {
  const file = resolve(workspaceRoot, APPROVED_UNDEPLOYED_EDITS);
  if (!existsSync(file)) return { edits: [], deletions: [] };
  return approvedEditSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/**
 * A one-time, owner-approved deletion of a baseline migration that had run on
 * no deployed environment (`migrations/approved-undeployed-edits.json`).
 * The rehearsal baseline then simply lacks it, as every deployed database does.
 */
async function isApprovedUndeployedDeletion(
  workspaceRoot: string,
  file: string,
): Promise<boolean> {
  return (await readApprovedUndeployedChanges(workspaceRoot)).deletions.some(
    (deletion) => deletion.file === file,
  );
}

/**
 * A one-time, owner-approved edit to a baseline migration that had run on no
 * deployed environment, pinned to its exact content
 * (`migrations/approved-undeployed-edits.json`). Shared with the
 * migration immutability rule.
 */
async function isApprovedUndeployedEdit(
  workspaceRoot: string,
  file: string,
): Promise<boolean> {
  const approved = (
    await readApprovedUndeployedChanges(workspaceRoot)
  ).edits.find((edit) => edit.file === file);
  if (approved === undefined) return false;
  const content = await readFile(resolve(workspaceRoot, file));
  return createHash("sha256").update(content).digest("hex") === approved.sha256;
}

type Git = (args: readonly string[]) => string;

export type MigrationCompatibilityDiff = {
  base: string;
  baselineFiles: readonly string[];
  addedFiles: readonly string[];
};

/**
 * What the pinned base commit already shipped and what this tree adds. A
 * baseline migration may never change, except by an owner-approved entry in
 * `migrations/approved-undeployed-edits.json`, and the support files baseline
 * migrations load must be identical to the base's.
 */
export async function readMigrationCompatibilityDiff(
  workspace: MigrationWorkspace,
  base: string,
): Promise<MigrationCompatibilityDiff> {
  const git = gitIn(workspace.root);
  const sources = workspace.sources.map((source) => source.root);
  const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]);
  if (!/^[a-f0-9]{40,64}$/.test(baseSha))
    throw new Error("migration comparison requires a pinned Git commit");
  const pinnedFiles = git([
    "ls-tree",
    "-r",
    "--name-only",
    baseSha,
    "--",
    ...sources,
  ])
    .split("\n")
    .filter((file) => isMigrationFile(workspace, file));
  const { additions, approvedDeletions } = await classifyCommittedChanges(
    workspace,
    git(["diff", "--name-status", "--no-renames", baseSha, "--", ...sources]),
  );
  const baselineFiles = pinnedFiles.filter(
    (file) => !approvedDeletions.has(file),
  );
  for (const file of git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...sources,
  ]).split("\n")) {
    if (isMigrationFile(workspace, file)) additions.add(file);
  }
  if (additions.size > 0)
    await refuseChangedBaselineSupport(workspace, git, baseSha, baselineFiles);
  return { base: baseSha, baselineFiles, addedFiles: [...additions].sort() };
}

function gitIn(workspaceRoot: string): Git {
  return (args) =>
    execFileSync("git", [...args], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
}

/** Sorts each changed migration into an addition, an approved change, or a refusal. */
async function classifyCommittedChanges(
  workspace: MigrationWorkspace,
  nameStatus: string,
): Promise<{ additions: Set<string>; approvedDeletions: Set<string> }> {
  const additions = new Set<string>();
  const approvedDeletions = new Set<string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    if (file === undefined || !isMigrationFile(workspace, file)) continue;
    const change = await classifyChange(workspace.root, status, file);
    if (change === "added") additions.add(file);
    if (change === "approved-deletion") approvedDeletions.add(file);
  }
  return { additions, approvedDeletions };
}

async function classifyChange(
  workspaceRoot: string,
  status: string | undefined,
  file: string,
): Promise<"added" | "approved-edit" | "approved-deletion"> {
  if (status === "A") return "added";
  if (status === "M" && (await isApprovedUndeployedEdit(workspaceRoot, file)))
    return "approved-edit";
  if (
    status === "D" &&
    (await isApprovedUndeployedDeletion(workspaceRoot, file))
  )
    return "approved-deletion";
  throw new Error(`immutable baseline migration differs: ${file}`);
}

async function refuseChangedBaselineSupport(
  workspace: MigrationWorkspace,
  git: Git,
  baseSha: string,
  baselineFiles: readonly string[],
): Promise<void> {
  const { migrationSupportFiles } =
    await import("../compatibility/migration-support-files.js");
  const support = await migrationSupportFiles(workspace, baselineFiles);
  if (support.length === 0) return;
  const pinnedSupport = new Set(
    git(["ls-tree", "-r", "--name-only", baseSha, "--", ...support]).split(
      "\n",
    ),
  );
  if (support.some((file) => !pinnedSupport.has(file)))
    throw new Error(
      "baseline migration support is absent from the pinned commit; remove untracked shadow modules before rehearsal",
    );
  if (git(["diff", "--name-only", baseSha, "--", ...support]) !== "")
    throw new Error(
      "baseline migration support differs from the pinned commit; version the helper or use a separately restored baseline",
    );
}

async function checkMigrationCompatibility(): Promise<void> {
  const workspace = defaultMigrationWorkspace(process.cwd());
  const diff = await readMigrationCompatibilityDiff(
    workspace,
    parseBaseArgument(process.argv.slice(2)),
  );
  if (diff.addedFiles.length === 0) {
    process.stdout.write(
      "migration compatibility: no pending SQL additions; no database started\n",
    );
    return;
  }
  const baselineNames = await baselineJournalNames(workspace, diff);
  const [{ RehearsalPostgres }, { rehearseMigrationCompatibility }] =
    await Promise.all([
      import("../../testing/index.js"),
      import("../compatibility/rehearse-migration-compatibility.js"),
    ]);
  const { postgres, stop } = await RehearsalPostgres.start();
  try {
    const result = await rehearseMigrationCompatibility({
      workspace,
      baselineNames,
      postgres,
    });
    process.stdout.write(`${JSON.stringify({ base: diff.base, ...result })}\n`);
  } finally {
    await stop();
  }
}

function parseBaseArgument(args: readonly string[]): string {
  const [argument] = args;
  if (
    args.length !== 1 ||
    argument === undefined ||
    !argument.startsWith("--base=")
  )
    throw new Error("usage: dads-migration-check --base=<comparison-ref>");
  return z.string().min(1).parse(argument.slice("--base=".length));
}

/** The base's migrations in applied order; refuses additions that schedule nothing. */
async function baselineJournalNames(
  workspace: MigrationWorkspace,
  diff: MigrationCompatibilityDiff,
): Promise<string[]> {
  const { planMigrationCompatibility } =
    await import("../compatibility/plan-migration-compatibility.js");
  const migrations = await discoverDomainMigrations({ workspace });
  const baselinePaths = new Set(diff.baselineFiles);
  const baselineNames = planMigrationOrder(
    migrations.filter((migration) =>
      baselinePaths.has(relative(workspace.root, migration.filePath)),
    ),
  ).map((migration) => migration.journalName);
  if (planMigrationCompatibility(migrations, baselineNames).orders.length === 0)
    throw new Error("SQL additions did not produce a compatibility schedule");
  return baselineNames;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  checkMigrationCompatibility().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "migration compatibility failed"}\n`,
    );
    process.exitCode = 1;
  });
}
