#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createDads,
  type DadsDevelopmentUrls,
  type DadsProjectCreation,
} from "./create-dads.js";

const argumentsAfterExecutable = process.argv.slice(2);
const wantsJson = argumentsAfterExecutable.includes("--json");
const wantsHelp =
  argumentsAfterExecutable.includes("--help") ||
  argumentsAfterExecutable.includes("-h");

const usageText = [
  "Usage: create-dads <directory> [options]",
  "",
  "Create a Postgres-backed TypeScript API with email sign-in, tenants,",
  "relationship-guarded notes, and named customer and staff entrypoints.",
  "",
  "Options:",
  "  --template <minimal|example>  Project template (default: example)",
  "  --name <name>                 Set the npm package name",
  "  --existing                    Add an isolated dads/ project to an existing repo",
  "  --dry-run                     List planned files without writing",
  "  --skip-install                Write files without running npm install or Docker startup",
  "  --skip-doctor                 Skip the initial Doctor report on an existing project",
  "  --today YYYY-MM-DD            Supply a date for the Doctor report",
  "  --yes                         Accept non-interactive defaults",
  "  --json                        Emit one machine-readable JSON result",
  "  -h, --help                    Show this help message",
  "",
].join("\n");

if (wantsHelp) {
  process.stdout.write(usageText);
} else {
  try {
    const creation = await createDads(argumentsAfterExecutable, {
      installDependencies: async (projectRoot) => {
        await runNpm(
          projectRoot,
          ["install", "--include=dev", "--include=optional", "--package-lock"],
          "npm install",
          wantsJson,
        );
      },
      startDevelopment,
      write: (text) => process.stdout.write(text),
    });
    reportCreation(creation);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown failure.";
    process.stderr.write(
      wantsJson
        ? `${JSON.stringify({ ok: false, error: message })}\n`
        : `Dads: ${message}\n`,
    );
    process.exitCode = 1;
  }
}

function reportCreation(creation: DadsProjectCreation): void {
  const { development, initialization } = creation;
  const projectRoot = initialization.projectRoot;
  if (development.status === "deferred") {
    const error = `Project installed in ${projectRoot}. Development startup is incomplete. ${development.reason}\nStart Docker with Compose, then run npm start from the project directory.`;
    process.stderr.write(
      wantsJson
        ? `${JSON.stringify({ ok: false, ...creation, error })}\n`
        : `Dads: ${error}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...creation })}\n`);
  } else if (development.status === "started") {
    process.stdout.write(
      `\nDads is ready in ${projectRoot}.\nOpen ${development.webUrl}\nCustomer API ${development.apiUrl}\nStaff API ${development.staffUrl}\nRun npm start from the project directory to start it again.\n`,
    );
  } else {
    const action = argumentsAfterExecutable.includes("--dry-run")
      ? "preview"
      : "files";
    process.stdout.write(`\nDads project ${action} in ${projectRoot}.\n`);
  }
}

async function startDevelopment(
  projectRoot: string,
): Promise<DadsDevelopmentUrls> {
  if (!wantsJson)
    process.stdout.write("Starting the local Docker application…\n");
  const output = await runNpm(
    projectRoot,
    ["run", "--silent", "dev:up", "--", "--json"],
    "Local development startup",
    true,
  );
  const response: unknown = JSON.parse(output);
  return readyUrls(response);
}

function readyUrls(result: unknown): DadsDevelopmentUrls {
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true ||
    !("webUrl" in result) ||
    !("apiUrl" in result) ||
    !("staffUrl" in result)
  ) {
    throw new Error(
      "The local launcher did not report ready application URLs.",
    );
  }
  return {
    webUrl: localUrl(result.webUrl),
    apiUrl: localUrl(result.apiUrl),
    staffUrl: localUrl(result.staffUrl),
  };
}

function localUrl(value: unknown): string {
  const url =
    typeof value === "string" && URL.canParse(value)
      ? new URL(value)
      : undefined;
  if (
    typeof value !== "string" ||
    url?.protocol !== "http:" ||
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error("The local launcher reported an invalid application URL.");
  }
  return value;
}

function npmCliPath(): string {
  const inherited = process.env["npm_execpath"];
  if (inherited && isAbsolute(inherited)) return inherited;
  return resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
}

async function runNpm(
  projectRoot: string,
  args: readonly string[],
  label: string,
  capture: boolean,
): Promise<string> {
  const windows = process.platform === "win32";
  const command = windows ? process.execPath : "npm";
  const commandArgs = windows ? [npmCliPath(), ...args] : args;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-16_384);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else {
        const detail = (stderr || stdout).trim();
        reject(
          new Error(
            detail.length > 0
              ? `${label} exited with code ${String(code)}: ${detail}`
              : `${label} exited with code ${String(code)}.`,
          ),
        );
      }
    });
  });
}
