import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isRecord, isString, isUnknownArray } from "../parse-guards.js";

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export const defaultDomainBoundaries = {
  domains: ["src/domains/*", "domains/*"],
  libraries: ["libraries/*"],
  workflows: ["workflows"],
  integrations: ["integrations/*"],
  composition: ["src/composition", "apps/*", "assembly"],
};

export type OwnerKind = keyof typeof defaultDomainBoundaries;
export type Owner = { readonly kind: OwnerKind; readonly root: string };

const OPTIONAL_OWNER_KINDS = new Set<OwnerKind>(["workflows", "integrations"]);

export function readOwners(root: string): readonly Owner[] {
  const manifest: unknown = JSON.parse(readFileSync(join(root, "dads.project.json"), "utf8"));
  if (!isRecord(manifest)) throw new Error("Dads project must be an object.");
  const configured = manifest["domainBoundaries"];
  const policy = configured === undefined ? defaultDomainBoundaries : configured;
  if (!isRecord(policy)) throw new Error("domainBoundaries must be an object.");
  const owners = [
    ...readOwnerKind(root, policy, "domains"),
    ...readOwnerKind(root, policy, "libraries"),
    ...readOwnerKind(root, policy, "workflows"),
    ...readOwnerKind(root, policy, "integrations"),
    ...readOwnerKind(root, policy, "composition"),
  ];
  requireDistinctOwners(owners);
  return owners.sort((first, second) => second.root.length - first.root.length);
}

function readOwnerKind(project: string, policy: Record<string, unknown>, kind: OwnerKind): readonly Owner[] {
  const configured = policy[kind];
  const directories =
    configured === undefined && OPTIONAL_OWNER_KINDS.has(kind) ? defaultDomainBoundaries[kind] : configured;
  if (!isUnknownArray(directories) || !directories.every(isString)) {
    throw new Error(`domainBoundaries.${kind} must be an array of directories.`);
  }
  return directories.flatMap((entry) => expandOwnerRoot(project, entry, kind).map((root) => ({ kind, root })));
}

function expandOwnerRoot(project: string, entry: string, kind: OwnerKind): readonly string[] {
  const expand = entry.endsWith("/*");
  const directory = expand ? entry.slice(0, -2) : entry;
  if (
    directory.split("/").some((segment) => ignoredDirectory(segment) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment))
  ) {
    throw new Error(
      `Invalid domain boundary directory ${JSON.stringify(entry)}. Use a project-relative path or a trailing /*.`,
    );
  }
  const path = join(project, directory);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`Domain boundary directory ${directory} must be a real directory inside the project.`);
  }
  if (!expand) return [path];
  const children = readdirSync(path, { withFileTypes: true });
  if (kind === "workflows" && children.some((child) => child.isFile() && SOURCE_FILE.test(child.name))) {
    return [path];
  }
  return children
    .filter((child) => child.isDirectory() && !ignoredDirectory(child.name))
    .map((child) => join(path, child.name));
}

function requireDistinctOwners(owners: readonly Owner[]): void {
  for (const [index, owner] of owners.entries()) {
    const overlap = owners
      .slice(index + 1)
      .find((other) => contains(owner.root, other.root) || contains(other.root, owner.root));
    if (overlap) {
      throw new Error(`Domain boundary directories overlap: ${owner.root} and ${overlap.root}.`);
    }
  }
}

export function contains(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function ignoredDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "dist" || name === "coverage";
}

export function boundaryOwnerOf(owners: readonly Owner[], file: string): Owner | undefined {
  return owners.find((owner) => contains(owner.root, file));
}

export function ownerSubpath(owner: Owner, file: string): string {
  return relative(owner.root, file).split(sep).join("/");
}

export function isPublicEntry(owner: Owner, file: string): boolean {
  const subpath = ownerSubpath(owner, file);
  if (owner.kind === "domains" && subpath === "web-client/index.ts") return true;
  return /^(?:(?:src|dist)\/)?index\.(?:d\.)?(?:[cm]?[jt]s|tsx|jsx)$/.test(subpath);
}
