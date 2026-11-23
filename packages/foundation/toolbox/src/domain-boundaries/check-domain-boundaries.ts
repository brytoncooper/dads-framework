import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { findDadsProjectRoot } from "../project-files.js";
import { moduleReferences } from "./module-references.js";
import { isPublicEntry, boundaryOwnerOf, readOwners, type Owner } from "./ownership.js";
import { createSourceResolution, isLocalTarget } from "./source-resolution.js";

type Violation = {
  readonly source: string;
  readonly target: string;
  readonly specifier: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

export function checkDomainBoundaries(startPath: string) {
  const project = realpathSync(findDadsProjectRoot(startPath));
  const owners = readOwners(project);
  if (owners.every(({ kind }) => kind === "composition")) return { ok: true, violations: [] };
  const resolution = createSourceResolution(project);
  const violations: Violation[] = [];
  for (const path of resolution.files(owners)) {
    const sourceOwner = boundaryOwnerOf(owners, path);
    const source = resolution.read(path);
    for (const { literal, node, require } of moduleReferences(source)) {
      const target = resolution.resolve(source, literal, require);
      if (!target || !isLocalTarget(project, target)) continue;
      const message = rejection(sourceOwner, boundaryOwnerOf(owners, target), target);
      if (!message) continue;
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({
        source: relative(project, path),
        target: relative(project, target),
        specifier: literal.text,
        line: line + 1,
        column: character + 1,
        message,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

function rejection(source: Owner | undefined, target: Owner | undefined, file: string): string | undefined {
  if (source === target) return undefined;
  if (target?.kind === "domains") {
    return domainRejection(source, isPublicEntry(target, file));
  }
  if (target?.kind === "libraries" && !isPublicEntry(target, file)) {
    return "Import the neutral library through its public index entry point.";
  }
  if (sourceMustStayLocal(source) && isAppWiring(target)) {
    return "Move the dependency into this owner or expose it from a neutral library. Bind implementation dependencies in composition.";
  }
  return undefined;
}

function sourceMustStayLocal(owner: Owner | undefined): boolean {
  return owner?.kind === "domains" || owner?.kind === "libraries";
}

function isAppWiring(owner: Owner | undefined): boolean {
  return owner === undefined || owner.kind === "composition";
}

function domainRejection(source: Owner | undefined, isPublic: boolean): string | undefined {
  if (source?.kind === "composition") {
    return isPublic ? undefined : "Composition must import the domain through its public index entry point.";
  }
  if (source?.kind === "domains") {
    return "A domain cannot import a peer domain. Define the needed port in the consuming domain and bind the provider in composition.";
  }
  return "Import domains from composition through their public entry points. Neutral libraries must stay independent of domains.";
}
