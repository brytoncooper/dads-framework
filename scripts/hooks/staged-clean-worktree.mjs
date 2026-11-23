import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { git } from "./staged-snapshot.mjs";

// Installed dependencies and ordinary build output are shared with snapshots.
const ignoredOutputs = ["node_modules/", "dist/", "coverage/", "target/", ".dads/", "*.tsbuildinfo"];

function gitConfig(root, key) {
  const result = spawnSync("git", ["config", "--get", key], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 1) return "";
  if (result.status !== 0) throw new Error(`Cannot read Git setting ${key}.`);
  return result.stdout.trim();
}

function systemAttributesPath(root) {
  const result = spawnSync("git", ["var", "GIT_ATTR_SYSTEM"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function hasCheckoutTransforms(root, entries) {
  const eol = gitConfig(root, "core.autocrlf");
  if (eol !== "" && eol !== "false") return true;
  const localAttributes = git(root, ["rev-parse", "--git-path", "info/attributes"], { encoding: "utf8" }).trim();
  const attributePath = gitConfig(root, "core.attributesFile");
  const systemAttributes = systemAttributesPath(root);
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return (
    existsSync(resolve(root, localAttributes)) ||
    existsSync(join(configHome, "git/attributes")) ||
    attributePath !== "" ||
    systemAttributes === undefined ||
    (systemAttributes !== "" && existsSync(systemAttributes)) ||
    entries.some((entry) => /(?:^|\/)\.gitattributes$/.test(entry.slice(2)))
  );
}

export function isCleanWorktree(root) {
  const tracked = git(root, ["ls-files", "-v", "-z"], { encoding: "utf8" });
  const entries = tracked.split("\0");
  if (entries.some((entry) => entry !== "" && !entry.startsWith("H "))) {
    return false;
  }
  if (hasCheckoutTransforms(root, entries)) return false;
  const unstaged = git(root, ["diff-files", "--name-only", "--ignore-submodules=none", "-z"]);
  if (unstaged.length > 0) return false;
  const untracked = git(root, [
    "ls-files",
    "--others",
    "-z",
    ...ignoredOutputs.map((pattern) => `--exclude=${pattern}`),
  ]);
  return untracked.length === 0;
}
