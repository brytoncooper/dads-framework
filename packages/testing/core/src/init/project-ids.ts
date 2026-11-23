import type { WorkspacePackage } from "./package-inventory.js";

/**
 * Project ids are read by people in task ids, plan output and failure messages,
 * so they are derived from the package name a developer already knows. The
 * directory is the fallback, and a collision that survives both is an error
 * rather than a silent rename: two projects sharing an id would silently share
 * a fallback.
 */

export type ProjectIdSource = "package-name" | "directory";

export type ProjectIdAssignment = {
  readonly directory: string;
  readonly projectId: string;
  readonly source: ProjectIdSource;
};

const outsideIdentifier = /[^A-Za-z0-9\-_.:]+/g;

/** Reduces one name to the identifier charset the native engine accepts. */
export function sanitizeIdentifier(value: string): string {
  const withoutScopeMarker = value.startsWith("@") ? value.slice(1) : value;
  const separated = withoutScopeMarker.split("/").join("-");
  const identifier = separated.replace(outsideIdentifier, "-");
  return trimDashes(identifier);
}

export function assignProjectIds(packages: readonly WorkspacePackage[]): readonly ProjectIdAssignment[] {
  const assignments: ProjectIdAssignment[] = [];
  const takenIds = new Map<string, string>();

  for (const workspacePackage of packages) {
    const fromName = workspacePackage.name === undefined ? "" : sanitizeIdentifier(workspacePackage.name);
    if (fromName.length > 0 && !takenIds.has(fromName)) {
      takenIds.set(fromName, workspacePackage.directory);
      assignments.push({
        directory: workspacePackage.directory,
        projectId: fromName,
        source: "package-name",
      });
      continue;
    }

    const fromDirectory = identifierForDirectory(workspacePackage.directory);
    const owner = takenIds.get(fromDirectory);
    if (owner !== undefined) {
      throw new Error(
        `Cannot assign a unique project id: ${owner} and ${workspacePackage.directory} both resolve to ${fromDirectory}.`,
      );
    }
    takenIds.set(fromDirectory, workspacePackage.directory);
    assignments.push({
      directory: workspacePackage.directory,
      projectId: fromDirectory,
      source: "directory",
    });
  }

  return assignments;
}

/** The workspace root is a package too, and "." is not a readable id. */
function identifierForDirectory(directory: string): string {
  if (directory === ".") return "root";
  const identifier = sanitizeIdentifier(directory);
  return identifier.length > 0 ? identifier : "root";
}

function trimDashes(value: string): string {
  let trimmed = value;
  while (trimmed.startsWith("-")) trimmed = trimmed.slice(1);
  while (trimmed.endsWith("-")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}
