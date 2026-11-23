import { resolve } from "node:path";

import { writeOutput } from "./cli-io.js";
import { migrateWorkspaceToV03, type MigrateToV03Result } from "./migrate-v03.js";

const SUPPORTED_TARGETS = new Set(["0.3", "0.3.0"]);

export function migrateCommand(args: readonly string[], json: boolean): void {
  const positional: string[] = [];
  let dryRun = false;

  for (const argument of args) {
    if (argument === "--json") continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown migrate option "${argument}".`);
    }
    positional.push(argument);
  }

  const [target, directory] = positional;
  if (target === undefined || !SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Unsupported migration target ${JSON.stringify(target ?? "")}. Supported targets: 0.3`);
  }

  const result = migrateWorkspaceToV03({
    root: resolve(directory ?? process.cwd()),
    dryRun,
  });

  if (json) {
    writeOutput({ ok: true, migration: result }, true);
    return;
  }

  process.stdout.write(`${formatHumanSummary(result)}\n`);
}

function formatHumanSummary(result: MigrateToV03Result): string {
  if (result.filesChanged.length === 0) {
    return "Dad migrate 0.3: already up to date (0 files changed).";
  }
  const verb = result.dryRun ? "Would update" : "Updated";
  const lines = [
    `Dad migrate 0.3: ${verb} ${String(result.filesChanged.length)} file(s) (${String(result.packageManifestsUpdated)} package.json, ${String(result.importReplacements)} import specifier(s)).`,
  ];
  if (result.addedPeers.length > 0) {
    lines.push(`Added newly-optional peer dependencies: ${result.addedPeers.join(", ")}`);
  }
  for (const file of result.filesChanged.slice(0, 25)) {
    lines.push(`  - ${file}`);
  }
  if (result.filesChanged.length > 25) {
    lines.push(`  ... and ${String(result.filesChanged.length - 25)} more file(s)`);
  }
  if (result.dryRun) {
    lines.push("Dry run: no files were written. Re-run without --dry-run to apply.");
  } else {
    lines.push("Next steps: run `npm install && npm run typecheck`.");
  }
  return lines.join("\n");
}
