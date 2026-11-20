#!/usr/bin/env node
/**
 * The source ratchet, which is now `dad doctor --gate`.
 *
 * This file used to be the engine: a generic ratchet over sixteen private
 * measures, with its own baseline reader, its own state machine, and its own
 * tests. All of that moved into the toolbox as `src/doctor/doctor-gate*.ts`,
 * where it is the product every adopting repository gets rather than a copy
 * this repository keeps for itself. What is left here is the path the hooks,
 * the guards, the workflow, and `package.json` already call, translating its
 * flags to the command and passing the exit code and the output straight
 * through. No flags at all means `--gate`.
 *
 * The one thing this wrapper decides for itself is what to do when the doctor
 * has not been built. In `--file` mode it says so and exits 0, because that
 * mode is the edit-time guard and a guard whose tool is missing must fail
 * **open** — an unbootstrapped checkout must not wedge every edit. In every
 * other mode it exits 1 and says to build, because a gate that passes because
 * it could not run is the failure `DAD.md` calls gaslighting.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLBOX = join(ROOT, "packages", "foundation", "toolbox");
const EXECUTABLE = join(TOOLBOX, "bin", "dad.js");
const BUILT_COMMAND = join(TOOLBOX, "dist", "cli.js");
const BUILD_COMMAND = "npm run build";

/** The flags and options that already mean a mode; anything else adds --gate. */
const MODE_ARGUMENTS = new Set([
  "--gate",
  "--update",
  "--seed",
  "--report",
  "--file",
  "--base",
]);

/** The arguments `dad doctor` is handed, and whether this is the guard's mode. */
export function planDoctorArguments(argv) {
  const asksForAMode = argv.some((argument) => MODE_ARGUMENTS.has(argument));
  return {
    file: argv.includes("--file"),
    commandArguments: [
      "doctor",
      ROOT,
      ...(asksForAMode ? argv : ["--gate", ...argv]),
    ],
  };
}

/** What to print and exit with when `dist/cli.js` is not there. */
export function refuseUnbuilt(file) {
  if (file) {
    return {
      exitCode: 0,
      output: `check-source-budgets: dad doctor is not built (${BUILT_COMMAND}); skipping this file. Run ${BUILD_COMMAND}.\n`,
    };
  }
  return {
    exitCode: 1,
    output: `check-source-budgets: dad doctor is not built (${BUILT_COMMAND}). Run ${BUILD_COMMAND} first.\n`,
  };
}

function main(argv) {
  const plan = planDoctorArguments(argv);
  if (!existsSync(BUILT_COMMAND)) {
    const refusal = refuseUnbuilt(plan.file);
    process.stdout.write(refusal.output);
    return refusal.exitCode;
  }
  const finished = spawnSync(
    process.execPath,
    [EXECUTABLE, ...plan.commandArguments],
    { cwd: ROOT, stdio: "inherit" },
  );
  return finished.status ?? 1;
}

/**
 * True when this file is the program rather than an import. The comparison is
 * between real paths: a repository under a symlinked directory — `/var` on
 * macOS, a worktree reached through one — hands `process.argv[1]` the link and
 * `import.meta.url` the file it points at, and a wrapper that printed nothing
 * there would be a guard that silently passed everything.
 */
const invokedPath =
  process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
const isMainModule = invokedPath === fileURLToPath(import.meta.url);

if (isMainModule) {
  process.exitCode = main(process.argv.slice(2));
}
