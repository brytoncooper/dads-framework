#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { helpFor } from "./usage.js";

const entrypoint = new URL("../dist/cli.js", import.meta.url);
const workspaceRoot = new URL("../../../../", import.meta.url);
const sourceEntry = new URL(
  "packages/foundation/toolbox/bin/dad.js",
  workspaceRoot,
);

const help = helpFor(process.argv.slice(2));
if (help !== undefined) {
  process.stdout.write(`${help}\n`);
} else if (existsSync(entrypoint) || buildSourceCli()) {
  await import(entrypoint.href);
}

function buildSourceCli() {
  const isSourceWorkspace =
    sourceEntry.href === import.meta.url &&
    existsSync(new URL("dads.project.json", workspaceRoot)) &&
    existsSync(
      new URL("packages/foundation/toolbox/src/cli.ts", workspaceRoot),
    );
  if (!isSourceWorkspace) {
    return fail(
      "CLI build files are missing. Reinstall @dads-framework/toolbox.",
    );
  }

  const root = fileURLToPath(workspaceRoot);
  const compiler = join(root, "node_modules/typescript-native/bin/tsc");
  if (!existsSync(compiler) || isInstallOrCommit()) {
    return fail(
      "CLI files are missing. Run npm ci and npm run build:cli from the source repository.",
    );
  }

  const buildDirectory = join(root, ".dads");
  const lock = join(buildDirectory, "source-cli-build.lock");
  mkdirSync(buildDirectory, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return fail(
      "A source CLI build is in progress. Retry when it finishes. To recover an interrupted build, run npm run build:cli -- --force.",
    );
  }
  try {
    if (existsSync(entrypoint)) return true;
    const build = spawnSync(
      process.execPath,
      [compiler, "-b", "packages/foundation/toolbox", "--pretty", "false"],
      { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
    );
    return (
      (build.status === 0 && existsSync(entrypoint)) ||
      fail(
        "The source CLI build failed. Run npm run build:cli -- --force for a clean rebuild.",
      )
    );
  } finally {
    rmdirSync(lock);
  }
}

function isInstallOrCommit() {
  return (
    process.env.GIT_INDEX_FILE !== undefined ||
    ["preinstall", "install", "postinstall", "prepare"].includes(
      process.env.npm_lifecycle_event,
    )
  );
}

function fail(message) {
  process.stderr.write(
    process.argv.includes("--json")
      ? `${JSON.stringify({ ok: false, error: message })}\n`
      : `Dad: ${message}\n`,
  );
  process.exitCode = 1;
  return false;
}
