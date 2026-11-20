import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

function workspacePath(root, link) {
  const target = relative(root, realpathSync(link));
  if (
    isAbsolute(target) ||
    target === ".." ||
    target.startsWith(".." + sep) ||
    target.startsWith("node_modules" + sep)
  ) {
    return undefined;
  }
  return target;
}

function linkDirectory(from, to) {
  if (existsSync(from) && !existsSync(to)) symlinkSync(from, to, "dir");
}

function linkWorkspace(root, snapshot, path, to) {
  const staged = join(snapshot, path);
  if (!existsSync(join(staged, "package.json"))) return;
  for (const dependency of ["dist", "node_modules"]) {
    linkDirectory(join(root, path, dependency), join(staged, dependency));
  }
  symlinkSync(staged, to, "dir");
}

function installLinks(root, snapshot, from, to, scopes) {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const origin = join(from, entry.name);
    const destination = join(to, entry.name);
    if (scopes && entry.name.startsWith("@") && entry.isDirectory()) {
      installLinks(root, snapshot, origin, destination, false);
      continue;
    }
    const workspace =
      entry.isSymbolicLink() && existsSync(origin)
        ? workspacePath(root, origin)
        : undefined;
    if (workspace === undefined) symlinkSync(origin, destination);
    else linkWorkspace(root, snapshot, workspace, destination);
  }
}

export function linkStagedDependencies(root, snapshot) {
  const localModules = join(root, "node_modules");
  const stagedModules = join(snapshot, "node_modules");
  installLinks(root, snapshot, localModules, stagedModules, true);
}
