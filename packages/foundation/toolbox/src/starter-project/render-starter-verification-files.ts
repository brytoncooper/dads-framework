import type { StarterProjectFile } from "./render-starter-project.js";
import { renderStarterStagedChecks } from "./render-starter-staged-checks.js";
import { starterCiFiles } from "./starter-ci-workflow.js";

/** The starter keeps its verifier in the generated project, with its checks. */
export function renderStarterVerificationFiles(): readonly StarterProjectFile[] {
  return [
    {
      path: ".githooks/install",
      content: `#!/bin/sh
set -eu
prefix=$(git rev-parse --show-prefix)
if [ -n "$prefix" ]; then
  printf '%s\\n' 'Install hooks from the root of the Git repository.' >&2
  exit 1
fi
git config --local core.hooksPath .githooks
`,
    },
    {
      path: ".githooks/pre-commit",
      executable: true,
      content: `#!/bin/sh
set -eu
exec node scripts/verify.mjs --pre-commit
`,
    },
    {
      path: ".githooks/pre-push",
      executable: true,
      content: `#!/bin/sh
set -eu
exec node scripts/verify.mjs --pre-push
`,
    },
    ...starterCiFiles,
    renderVerificationRunner(),
    renderStarterStagedChecks(),
  ];
}

function renderVerificationRunner(): StarterProjectFile {
  return {
    path: "scripts/verify.mjs",
    content: String.raw`/** Verify the committed starter checkout before it is pushed. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const root = process.cwd();
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
environment.GIT_NO_REPLACE_OBJECTS = "1";
// npm adds the parent project's node_modules/.bin to PATH for npm scripts.
// Do not let a detached verification run use tools from the working checkout.
const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
if (pathKey) {
  environment[pathKey] = environment[pathKey].split(delimiter)
    .filter((path) => !path.endsWith(join("node_modules", ".bin")))
    .join(delimiter);
}

function run(directory, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: directory,
    env: environment,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " failed.");
  }
  return result.stdout;
}

function git(args, directory = root) {
  return run(directory, "git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function historyOverlay(name, directory) {
  const path = resolve(directory, git(["rev-parse", "--git-path", name], directory).trimEnd());
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function contextOf(revision, directory = root) {
  const commit = git(["rev-parse", "--verify", "--end-of-options", revision + "^{commit}"], directory).trim();
  const tree = git(["rev-parse", "--verify", commit + "^{tree}"], directory).trim();
  const base = git(["rev-parse", "--revs-only", "origin/main^{commit}", "main^{commit}"], directory)
    .trim().split("\n")[0] || null;
  return { commit, tree, base, shallow: historyOverlay("shallow", directory), grafts: historyOverlay("info/grafts", directory) };
}

function sameContext(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanContext(directory) {
  if (git(["rev-parse", "--show-prefix"], directory).trim() !== "") return undefined;
  if (git(["status", "--porcelain=v1", "--untracked-files=all"], directory) !== "") return undefined;
  const entries = git(["ls-files", "-v", "-z"], directory).split("\0");
  if (entries.some((entry) => entry !== "" && !entry.startsWith("H "))) return undefined;
  if (git(["ls-files", "--stage"], directory).split("\n").some((entry) => entry.startsWith("160000 "))) return undefined;
  return contextOf("HEAD", directory);
}

function receiptFor(context) {
  const commonDirectory = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const platform = [process.version, process.platform, process.arch].join(":");
  const key = createHash("sha256").update(JSON.stringify({ context, platform })).digest("hex");
  return resolve(commonDirectory, "dads", "starter-verification", key + ".json");
}

function hasReceipt(context) {
  try {
    const receipt = JSON.parse(readFileSync(receiptFor(context), "utf8"));
    return sameContext(receipt.context, context) && receipt.check === "npm run verify:checks" &&
      typeof receipt.passedAt === "string" && Number.isFinite(Date.parse(receipt.passedAt));
  } catch {
    return false;
  }
}

function writeReceipt(context) {
  const path = receiptFor(context);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".partial";
  try {
    writeFileSync(temporary, JSON.stringify({
      context,
      check: "npm run verify:checks",
      passedAt: new Date().toISOString(),
    }) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function measure(hook, start) {
  try {
    mkdirSync(".dads", { recursive: true });
    appendFileSync(".dads/hook-timings.jsonl", JSON.stringify({
      hook,
      durationMs: Math.round(performance.now() - start),
    }) + "\n");
  } catch {
    // Diagnostic timing never decides whether Git will proceed.
  }
}

function revisionsToPush(input) {
  const format = git(["rev-parse", "--show-object-format"]).trim();
  const length = { sha1: 40, sha256: 64 }[format];
  if (length === undefined) throw new Error("Unsupported Git object format.");
  const oid = new RegExp("^[a-f0-9]{" + length + "}$");
  const zero = "0".repeat(length);
  const revisions = new Set();
  for (const line of input.trimEnd().split("\n")) {
    if (line === "" && input === "") continue;
    const fields = line.split(" ");
    const [localRef, local, remoteRef, remote] = fields;
    if (fields.length !== 4 || !localRef || !remoteRef || !oid.test(local) ||
        !oid.test(remote) || (localRef === "(delete)") !== (local === zero)) {
      throw new Error("Invalid Git pre-push input.");
    }
    if (local !== zero) revisions.add(local);
  }
  return revisions;
}

function verifyCommitted(context) {
  const temporary = mkdtempSync(join(tmpdir(), "dads-starter-proof-"));
  const checkout = join(temporary, "checkout");
  try {
    git(["worktree", "add", "--detach", checkout, context.commit]);
    if (!sameContext(cleanContext(checkout), context)) throw new Error("Cannot verify the requested Git context.");
    run(checkout, "npm", ["ci", "--no-audit", "--no-fund"]);
    run(checkout, "npm", ["run", "verify:checks"]);
    if (!sameContext(cleanContext(checkout), context)) throw new Error("Verification changed the Git context.");
    writeReceipt(context);
  } finally {
    try {
      if (existsSync(join(checkout, ".git"))) git(["worktree", "remove", "--force", checkout]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function prePush() {
  const start = performance.now();
  const revisions = revisionsToPush(readFileSync(0, "utf8"));
  let reused = revisions.size > 0;
  for (const revision of revisions) {
    const context = contextOf(revision);
    if (hasReceipt(context)) continue;
    reused = false;
    verifyCommitted(context);
    if (!sameContext(contextOf(revision), context) || !hasReceipt(context)) throw new Error("Missing passing receipt for " + revision);
  }
  if (reused) measure("pre-push", start);
}

function verify() {
  const inGit = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    env: environment,
    stdio: "ignore",
  }).status === 0;
  const context = inGit && !process.env.CI ? cleanContext(root) : undefined;
  if (context === undefined) run(root, "npm", ["run", "verify:checks"]);
  else verifyCommitted(context);
}

try {
  switch (process.argv[2]) {
    case undefined:
      verify();
      break;
    case "--pre-commit": {
      const start = performance.now();
      try {
        // Git's hook environment may name an alternate index for this commit.
        run(root, process.execPath, ["scripts/check-staged.mjs"], { env: process.env });
      } finally {
        measure("pre-commit", start);
      }
      break;
    }
    case "--pre-push":
      prePush();
      break;
    default:
      throw new Error("Unknown verify option: " + process.argv[2]);
  }
} catch (error) {
  process.stderr.write("verify: " + error.message + "\n");
  process.exitCode = 1;
}
`,
  };
}
