import { fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

// Dependency-free bootstrap: only project packages/images may be acquired.
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const [major, minor] = process.versions.node.split(".").map(Number);
let child;
let interrupted = false;
const stop = () => {
  interrupted = true;
  child?.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  if (major < 22 || (major === 22 && minor < 14))
    throw new Error(
      "Workbench requires Node.js 22.14 or newer. No host software was changed.",
    );
  if (args.includes("--help")) {
    process.stdout.write(
      "npm run workbench:dev -- [--instance name] [--port 0..65535] [--adapter postgres|spicedb]\n",
    );
    process.stdout.write("npm run workbench:stop -- [--instance name]\n");
    process.stdout.write(
      "Requires Node.js 22.14+ and a running Docker engine with Compose. Data is preserved on stop.\n",
    );
    process.stdout.write(
      "New instances use Postgres by default; existing instances retain their recorded backend.\n",
    );
  } else {
    const compiler = join(root, "node_modules/typescript/bin/tsc");
    const entrypoint = join(root, "apps/workbench/dist/development/cli.js");
    // Stop must still work while the developer has a TypeScript error in progress.
    if (args[0] !== "stop" || !existsSync(entrypoint)) {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      if (!existsSync(compiler) || (await missingDependencies(npm))) {
        process.stdout.write(
          "Installing the workbench repository's locked npm dependencies.\n",
        );
        await command(npm, ["ci"]);
      }
      await command(process.execPath, [
        compiler,
        "-b",
        "apps/workbench",
        "--pretty",
        "false",
      ]);
    }
    if (!interrupted) {
      child = fork(entrypoint, args, {
        cwd: root,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      await completion(child);
    }
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Workbench command failed."}\n`,
  );
  process.exitCode = interrupted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

function missingDependencies(npm) {
  if (interrupted) return Promise.resolve(false);
  child = spawn(npm, ["ls", "--all", "--json"], { cwd: root, stdio: "ignore" });
  const checking = child;
  return new Promise((resolve, reject) => {
    checking.once("error", () =>
      reject(new Error("npm could not check the project's dependencies.")),
    );
    checking.once("exit", (code) => resolve(code !== 0));
  });
}

async function command(executable, arguments_) {
  if (interrupted) throw new Error("Workbench startup interrupted.");
  child = spawn(executable, arguments_, { cwd: root, stdio: "inherit" });
  await completion(child);
}

function completion(running) {
  return new Promise((resolve, reject) => {
    running.once("error", () =>
      reject(new Error("A required project command could not start.")),
    );
    running.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Workbench command exited with status ${String(code)}.`),
        );
    });
  });
}
