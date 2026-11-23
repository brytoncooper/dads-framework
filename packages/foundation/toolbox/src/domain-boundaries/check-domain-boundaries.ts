import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import type ts from "typescript";
import { findDadsProjectRoot } from "../project-files.js";
import { moduleReferences } from "./module-references.js";
import { boundaryOwnerOf, isPublicEntry, ownerSubpath, readOwners, type Owner } from "./ownership.js";
import { createSourceResolution, isLocalTarget } from "./source-resolution.js";

type Violation = {
  readonly source: string;
  readonly target: string;
  readonly specifier: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

type ResolvedReference = {
  readonly target: string;
  readonly literal: ts.StringLiteralLike;
  readonly node: ts.Node;
};

type BarrelState = {
  server: ResolvedReference | undefined;
  client: ResolvedReference | undefined;
};

type SourceResolution = ReturnType<typeof createSourceResolution>;

const DOMAIN_ROOT_BARREL = /^(?:src\/)?index\.[cm]?[jt]sx?$/;
const TOP_LEVEL_TEST_FILE = /^tests\/.*\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/;

export function checkDomainBoundaries(startPath: string) {
  const project = realpathSync(findDadsProjectRoot(startPath));
  const owners = readOwners(project);
  if (owners.every(({ kind }) => kind === "composition")) return { ok: true, violations: [] };
  const resolution = createSourceResolution(project);
  const violations: Violation[] = [];
  for (const path of resolution.files(owners)) {
    checkFile(project, owners, resolution, path, violations);
  }
  return { ok: violations.length === 0, violations };
}

function checkFile(
  project: string,
  owners: readonly Owner[],
  resolution: SourceResolution,
  path: string,
  violations: Violation[],
): void {
  const sourceOwner = boundaryOwnerOf(owners, path);
  const source = resolution.read(path);
  const barrel: BarrelState | undefined = isDomainRootBarrel(sourceOwner, path)
    ? { server: undefined, client: undefined }
    : undefined;

  for (const { literal, node, require } of moduleReferences(source)) {
    const target = resolution.resolve(source, literal, require);
    if (!target || !isLocalTarget(project, target)) continue;
    const reference: ResolvedReference = { target, literal, node };
    const targetOwner = boundaryOwnerOf(owners, target);
    const message = edgeRejection(project, sourceOwner, path, targetOwner, target);
    if (message) violations.push(toViolation(project, source, path, reference, message));
    recordBarrelReference(barrel, sourceOwner, targetOwner, reference);
  }

  const mixed = mixedBarrelViolation(project, source, path, barrel);
  if (mixed !== undefined) violations.push(mixed);
}

function recordBarrelReference(
  barrel: BarrelState | undefined,
  sourceOwner: Owner | undefined,
  targetOwner: Owner | undefined,
  reference: ResolvedReference,
): void {
  if (barrel === undefined || sourceOwner === undefined) return;
  const side = domainBarrelSide(sourceOwner, targetOwner, reference.target);
  if (side === "server" && barrel.server === undefined) barrel.server = reference;
  if (side === "client" && barrel.client === undefined) barrel.client = reference;
}

function mixedBarrelViolation(
  project: string,
  source: ts.SourceFile,
  path: string,
  barrel: BarrelState | undefined,
): Violation | undefined {
  if (barrel?.server === undefined || barrel.client === undefined) return undefined;
  return toViolation(
    project,
    source,
    path,
    barrel.client,
    "Domain root index.ts cannot mix server/ exports with web-client/ or ui/ exports; mixing server and client exports merges their affected graphs. Expose client code from web-client/index.ts.",
  );
}

function toViolation(
  project: string,
  source: ts.SourceFile,
  path: string,
  reference: ResolvedReference,
  message: string,
): Violation {
  const { line, character } = source.getLineAndCharacterOfPosition(reference.node.getStart(source));
  return {
    source: relative(project, path),
    target: relative(project, reference.target),
    specifier: reference.literal.text,
    line: line + 1,
    column: character + 1,
    message,
  };
}

function edgeRejection(
  project: string,
  source: Owner | undefined,
  sourceFile: string,
  target: Owner | undefined,
  targetFile: string,
): string | undefined {
  if (source === target) return intraDomainRejection(source, sourceFile, targetFile);
  if (target === undefined) return appWiringRejection(source);
  return crossOwnerRejection(project, source, sourceFile, target, targetFile);
}

function crossOwnerRejection(
  project: string,
  source: Owner | undefined,
  sourceFile: string,
  target: Owner,
  targetFile: string,
): string | undefined {
  switch (target.kind) {
    case "domains":
      return domainRejection(
        source,
        isTopLevelTestFile(project, sourceFile),
        isPublicEntry(target, targetFile),
        isDomainRootBarrel(target, targetFile),
      );
    case "libraries":
      return isPublicEntry(target, targetFile)
        ? undefined
        : "Import the neutral library through its public index entry point.";
    case "workflows":
      return workflowRejection(source);
    case "integrations":
      return isPublicEntry(target, targetFile)
        ? undefined
        : "Import the integration through its public index entry point.";
    case "composition":
      return appWiringRejection(source);
  }
}

function appWiringRejection(source: Owner | undefined): string | undefined {
  if (!sourceMustStayLocal(source)) return undefined;
  return "Move the dependency into this owner or expose it from a neutral library. Bind implementation dependencies in composition.";
}

function intraDomainRejection(owner: Owner | undefined, sourceFile: string, targetFile: string): string | undefined {
  if (owner?.kind !== "domains") return undefined;
  const from = ownerSubpath(owner, sourceFile);
  const to = ownerSubpath(owner, targetFile);
  if (from.startsWith("pure/")) {
    return to.startsWith("server/") ? "Pure domain modules under pure/ cannot import server/ modules." : undefined;
  }
  if (from.startsWith("contract/")) {
    return to.startsWith("server/") || to.startsWith("pure/")
      ? "Domain contract modules under contract/ cannot import server/ or pure/ modules."
      : undefined;
  }
  if (isAccessLayer(from) && to.startsWith("server/")) {
    return "Domain access modules cannot import server/ modules.";
  }
  return undefined;
}

function isAccessLayer(subpath: string): boolean {
  return subpath.startsWith("access/") || subpath === "access.ts";
}

function sourceMustStayLocal(owner: Owner | undefined): boolean {
  return owner?.kind === "domains" || owner?.kind === "libraries" || owner?.kind === "integrations";
}

function unownedDomainRejection(sourceIsTest: boolean, isRootBarrel: boolean): string | undefined {
  if (sourceIsTest) {
    return isRootBarrel ? undefined : "Tests must import domains through their public index entry point.";
  }
  return "Import domains from composition through their public entry points. Neutral libraries must stay independent of domains.";
}

function domainRejection(
  source: Owner | undefined,
  sourceIsTest: boolean,
  isPublic: boolean,
  isRootBarrel: boolean,
): string | undefined {
  if (source === undefined) return unownedDomainRejection(sourceIsTest, isRootBarrel);
  if (source.kind === "composition") {
    return isPublic ? undefined : "Composition must import the domain through its public index entry point.";
  }
  if (source.kind === "workflows") {
    return isPublic ? undefined : "Workflows must import domains through their public index entry points.";
  }
  if (source.kind === "domains") {
    return "A domain cannot import a peer domain. Define the needed port in the consuming domain and bind the provider in composition.";
  }
  if (source.kind === "integrations") {
    return "Integrations cannot import domains. Keep integrations independent and bind them in workflows or composition.";
  }
  return "Import domains from composition through their public entry points. Neutral libraries must stay independent of domains.";
}

function isTopLevelTestFile(project: string, file: string): boolean {
  const rel = relative(project, file).split(sep).join("/");
  return TOP_LEVEL_TEST_FILE.test(rel);
}

function workflowRejection(source: Owner | undefined): string | undefined {
  if (source?.kind === "domains" || source?.kind === "libraries") {
    return "Domains and neutral libraries cannot import workflows. Move orchestration into workflows or composition.";
  }
  if (source?.kind === "integrations") {
    return "Integrations cannot import workflows. Keep integrations independent of workflow orchestration.";
  }
  return undefined;
}

function isDomainRootBarrel(owner: Owner | undefined, file: string): boolean {
  return owner?.kind === "domains" && DOMAIN_ROOT_BARREL.test(ownerSubpath(owner, file));
}

function domainBarrelSide(
  owner: Owner,
  targetOwner: Owner | undefined,
  targetFile: string,
): "server" | "client" | undefined {
  if (owner !== targetOwner) return undefined;
  const subpath = ownerSubpath(owner, targetFile);
  if (subpath.startsWith("server/")) return "server";
  if (subpath.startsWith("web-client/") || subpath.startsWith("ui/")) return "client";
  return undefined;
}
