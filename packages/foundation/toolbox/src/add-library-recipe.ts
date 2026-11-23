import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderLibraryFiles } from "./library-recipe-files.js";
import { withLibraryRecipeLock, writeLibraryRecipe } from "./write-library-recipe.js";
import {
  assertLibraryRegistration,
  libraryPackageManifest,
  libraryProjectManifest,
  libraryTaskId,
} from "./library-recipe-manifests.js";
import { isRecord } from "./parse-guards.js";
import { findDadsProjectRoot } from "./project-files.js";
import { parseDadsProject } from "./project-orientation.js";

export function addLibraryRecipe(startPath: string, name: string, dryRun: boolean) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/.test(name)) {
    throw new Error("Library name must be lowercase words separated by hyphens.");
  }
  const projectRoot = findDadsProjectRoot(startPath);
  if (dryRun) return installLibrary(projectRoot, name, true);
  return withLibraryRecipeLock(projectRoot, () => installLibrary(projectRoot, name, false));
}

function installLibrary(projectRoot: string, name: string, dryRun: boolean) {
  const packageJson = readEditableManifest(projectRoot, "package.json");
  const projectJson = readEditableManifest(projectRoot, "dads.project.json");
  const library = describeLibrary(name, packageJson.data["name"]);
  const result = {
    projectRoot,
    root: library.root,
    packageName: library.packageName,
    contractName: library.contractName,
    files: library.capability.ownedFiles,
  };
  const project = parseDadsProject(projectJson.data);
  const workspace = libraryPackageManifest(packageJson.data, library);
  const alreadyInstalled = checkLibraryPath(projectRoot, project, library, workspace.registered);
  if (alreadyInstalled) {
    assertLibraryRegistration(project, library, workspace.verificationRegistered);
    return { ...result, status: "already-installed" as const };
  }
  const manifest = libraryProjectManifest(projectJson.data, library.owner, library.capability);
  if (dryRun) return { ...result, status: "planned" as const };
  writeLibraryRecipe(join(projectRoot, library.root), library.files, [
    { ...packageJson, data: workspace.manifest },
    { ...projectJson, data: manifest },
  ]);
  return { ...result, status: "installed" as const };
}

function describeLibrary(name: string, owningPackageName: unknown) {
  const root = `libraries/${name}`;
  const packageName = qualifyLibraryName(owningPackageName, name);
  const contractName =
    name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("") + "Contract";
  const files = renderLibraryFiles(packageName, contractName);
  const command = `npm test --workspace ${packageName}`;
  const owner = {
    name: packageName,
    root,
    responsibility: `Owns the public ${contractName} shared with consuming repositories.`,
    allowedDependencies: [],
    verification: [command],
    skills: [],
  };
  const capability = {
    name: `library:${name}`,
    recipeVersion: 1,
    profile: "dependency",
    client: "typescript",
    ownedFiles: Object.keys(files)
      .map((path) => `${root}/${path}`)
      .sort(),
  };
  return { root, packageName, contractName, files, owner, capability, command };
}

function qualifyLibraryName(owningPackageName: unknown, name: string): string {
  if (
    typeof owningPackageName !== "string" ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(owningPackageName)
  ) {
    throw new Error("The root package.json must declare an npm package name.");
  }
  const packageName = `${owningPackageName}-${name}`;
  if (packageName.length > 214) throw new Error("The library package name exceeds 214 characters.");
  return packageName;
}

function checkLibraryPath(
  projectRoot: string,
  project: ReturnType<typeof parseDadsProject>,
  library: ReturnType<typeof describeLibrary>,
  workspaceRegistered: boolean,
): boolean {
  const libraries = lstatSync(join(projectRoot, "libraries"), {
    throwIfNoEntry: false,
  });
  if (libraries && !libraries.isDirectory()) throw new Error("libraries must be a directory in the Dad project.");
  const installed = lstatSync(join(projectRoot, library.root), {
    throwIfNoEntry: false,
  });
  if (project.capabilities.some(({ name }) => name === library.capability.name)) {
    assertLibraryFiles(projectRoot, library, installed?.isDirectory() === true && workspaceRegistered);
    return true;
  }
  if (
    installed ||
    workspaceRegistered ||
    project.packages.some((entry) => entry.name === library.packageName || entry.root === library.root) ||
    project.verificationPolicy.tasks.some((entry) => entry.id === libraryTaskId(library.packageName))
  ) {
    throw new Error(`Refusing to overwrite an existing path or registration for ${library.root}.`);
  }
  return false;
}

function assertLibraryFiles(
  projectRoot: string,
  library: ReturnType<typeof describeLibrary>,
  workspaceExists: boolean,
): void {
  const hasFiles =
    workspaceExists &&
    library.capability.ownedFiles.every((path) =>
      lstatSync(join(projectRoot, path), { throwIfNoEntry: false })?.isFile(),
    );
  if (
    !hasFiles ||
    readEditableManifest(join(projectRoot, library.root), "package.json").data["name"] !== library.packageName
  ) {
    throw new Error(`Incomplete library registration for ${library.root}. Repair its files before retrying.`);
  }
}

function readEditableManifest(root: string, filename: string) {
  const path = join(root, filename);
  if (!lstatSync(path).isFile()) throw new Error(`${path} must be a regular file.`);
  const original = readFileSync(path, "utf8");
  const data: unknown = JSON.parse(original);
  if (!isRecord(data)) throw new Error(`${path} must contain a JSON object.`);
  return { path, original, data };
}
