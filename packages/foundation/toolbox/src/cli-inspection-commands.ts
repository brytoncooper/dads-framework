/**
 * The read-only `dad` commands: which package owns a path, what an operation
 * declares, which verification a change earns, and whether it passes.
 *
 * `skills:sync` is here too — it writes only the harness symlinks that make the
 * answers above reachable from every agent harness.
 */

import { relative } from "node:path";
import { commandDocumentation, documentedError } from "./cli-documentation.js";
import { loadDadsProject } from "./project-files.js";
import { orientProjectPath } from "./project-orientation.js";
import { recommendChangedVerification } from "./recommend-changed-verification.js";
import { synchronizeAgentSkills } from "./synchronize-agent-skills.js";
import { formatVerificationReport } from "./verification/format-verification-report.js";
import { readChangedScope } from "./verification/read-changed-scope.js";
import { verifyTaskGraph } from "./verification/verify-task-graph.js";
import { readOption, writeOutput } from "./cli-io.js";

export function orient(requestedPath: string | undefined, json: boolean): void {
  const cwd = process.cwd();
  if (!requestedPath) {
    throw documentedError("orient requires a project-relative path.", orientationGuide(cwd));
  }
  const loaded = loadOrientationProject(cwd);
  const projectPath = relative(loaded.root, requestedPath).startsWith("..")
    ? requestedPath
    : relative(loaded.root, requestedPath);
  const orientation = orientProjectPath(loaded.project, projectPath);
  if (!orientation) {
    throw documentedError(`No declared package owns ${projectPath}.`, orientationGuide(loaded.root));
  }

  const documentation = commandDocumentation(
    loaded.root,
    `${orientation.packageRoot}/README.md`,
    "docs/agent-operating-model.md",
    "README.md",
    "AGENTS.md",
  );
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, orientation, documentation })}\n`);
    return;
  }
  process.stdout.write(
    `${orientation.packageName}\n${orientation.responsibility}\nSkill: ${orientation.skills.join(", ")}\nVerify: ${orientation.verification.join(", ")}\nSee ${documentation}\n`,
  );
}

function orientationGuide(root: string): string {
  return commandDocumentation(root, "docs/agent-operating-model.md", "README.md", "AGENTS.md");
}

function loadOrientationProject(root: string) {
  try {
    return loadDadsProject(root);
  } catch (error) {
    throw documentedError(error, orientationGuide(root));
  }
}

export function recommendTests(commandArguments: readonly string[], json: boolean): void {
  const loaded = loadDadsProject(process.cwd());
  const changedScope = readCommandChangedScope(loaded.root, commandArguments);
  const recommendation = recommendChangedVerification(loaded.project, changedScope.paths, {
    trustEmptyScope: commandArguments.includes("--base"),
  });
  writeOutput(
    {
      ok: recommendation.complete,
      changedScope,
      recommendation,
      notApplicable: recommendation.tasks.length === 0,
    },
    json,
  );
  if (!recommendation.complete) process.exitCode = 1;
}

export function verifyChanged(commandArguments: readonly string[], json: boolean): void {
  const loaded = loadDadsProject(process.cwd());
  const changedScope = readCommandChangedScope(loaded.root, commandArguments);
  const recommendation = recommendChangedVerification(loaded.project, changedScope.paths, {
    trustEmptyScope: commandArguments.includes("--base"),
  });
  const report = verifyTaskGraph({
    projectRoot: loaded.root,
    project: loaded.project,
    recommendation,
    full: commandArguments.includes("--full"),
    cacheOff: verificationCacheOff(commandArguments),
    captureOutput: json,
    workspaceIdentity: changedScope.workspaceIdentity,
  });
  if (json) {
    writeOutput({ ok: report.ok, changedScope, recommendation, report }, true);
  } else {
    process.stdout.write(`${formatVerificationReport(report)}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

/** `CI` set (to anything but empty) or `--no-cache`: never read a receipt. */
function verificationCacheOff(commandArguments: readonly string[]): boolean {
  const ci = process.env["CI"];
  return commandArguments.includes("--no-cache") || (ci !== undefined && ci !== "");
}

function readCommandChangedScope(projectRoot: string, commandArguments: readonly string[]) {
  const baseRef = readOption(commandArguments, "--base");
  return baseRef ? readChangedScope(projectRoot, { baseRef }) : readChangedScope(projectRoot);
}

export function synchronize(json: boolean): void {
  const loaded = loadDadsProject(process.cwd());
  const synchronized = synchronizeAgentSkills(loaded.root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, synchronized })}\n`);
    return;
  }
  for (const harness of synchronized) {
    process.stdout.write(`${harness.harness}: ${harness.status}\n`);
  }
}
