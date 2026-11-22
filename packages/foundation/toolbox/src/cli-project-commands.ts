/** Create or adopt a project and install its dependencies when requested. */

import { spawnSync } from "node:child_process";
import {
  deriveDadsProjectName,
  initializeDadsProject,
} from "./initialize-dads-project.js";
import {
  dependenciesAreInstalled,
  recordDadsDependencyInstallation,
} from "./dependency-installation-receipt.js";
import { parseDadsInitializationArguments } from "./dads-initialization-arguments.js";
import { writeOutput } from "./cli-io.js";

export function initialize(
  argumentsAfterCommand: readonly string[],
  json: boolean,
): void {
  const request = parseDadsInitializationArguments(argumentsAfterCommand);
  const projectName =
    request.projectName ??
    deriveDadsProjectName(request.targetDirectory, request.mode);
  const initialization = initializeDadsProject({
    targetDirectory: request.targetDirectory,
    mode: request.mode,
    projectName,
    template: request.template,
    dryRun: request.dryRun,
  });
  const shouldInstall =
    !request.dryRun &&
    !request.skipInstall &&
    !dependenciesAreInstalled(initialization.projectRoot);
  if (shouldInstall) {
    installDependencies(initialization.projectRoot, json);
    recordDadsDependencyInstallation(initialization.projectRoot);
  }
  writeOutput({ ok: true, initialization, installed: shouldInstall }, json);
}

export function installDependencies(projectRoot: string, json: boolean): void {
  const completed = spawnSync(
    "npm",
    ["install", "--include=dev", "--include=optional", "--package-lock"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: json ? "pipe" : "inherit",
    },
  );
  if (completed.status !== 0) {
    const detail = `${completed.stderr}\n${completed.stdout}`.trim();
    throw new Error(
      detail.length > 0
        ? `npm install failed: ${detail}`
        : "npm install failed.",
    );
  }
}
