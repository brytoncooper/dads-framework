import { isRecord, isUnknownArray, isString } from "./parse-guards.js";
import {
  parseDadsProject,
  type DadsCapabilityInstallation,
  type DadsProject,
  type DadsPackageDeclaration,
} from "./project-orientation.js";

export function libraryPackageManifest(
  manifest: Record<string, unknown>,
  library: { readonly root: string; readonly command: string },
): {
  readonly registered: boolean;
  readonly verificationRegistered: boolean;
  readonly manifest: Record<string, unknown>;
} {
  const workspaces = manifest["workspaces"];
  const entries = isRecord(workspaces) ? workspaces["packages"] : workspaces;
  if (
    entries !== undefined &&
    (!isUnknownArray(entries) || !entries.every(isString))
  ) {
    throw new Error("package.json workspaces must contain an array of paths.");
  }
  const paths = entries ?? [];
  const registered = paths.includes(library.root);
  const packages = registered ? paths : [...paths, library.root];
  const verification = registerRootVerification(
    manifest["scripts"],
    library.command,
  );
  return {
    registered,
    verificationRegistered: verification.registered,
    manifest: {
      ...manifest,
      ...verification.update,
      workspaces: isRecord(workspaces) ? { ...workspaces, packages } : packages,
    },
  };
}

function registerRootVerification(scripts: unknown, command: string) {
  if (!isRecord(scripts) || typeof scripts["verify:checks"] !== "string") {
    return { registered: true, update: {} };
  }
  const checks = scripts["verify:checks"];
  const registered = checks.split(" && ").includes(command);
  return {
    registered,
    update: {
      scripts: {
        ...scripts,
        "verify:checks": registered ? checks : `${checks} && ${command}`,
      },
    },
  };
}

export function assertLibraryRegistration(
  project: DadsProject,
  library: {
    readonly owner: DadsPackageDeclaration;
    readonly capability: DadsCapabilityInstallation;
  },
  rootVerificationRegistered: boolean,
): void {
  const owner = project.packages.find(
    ({ root }) => root === library.owner.root,
  );
  const capability = project.capabilities.find(
    ({ name }) => name === library.capability.name,
  );
  const taskId = libraryTaskId(library.owner.name);
  if (
    owner?.name !== library.owner.name ||
    !rootVerificationRegistered ||
    !capabilityOwnsLibraryFiles(capability, library.capability) ||
    !libraryVerificationIsRegistered(project, library.owner.name, taskId)
  ) {
    throw new Error(
      `Incomplete library registration for ${library.owner.root}. Repair its manifest entries before retrying.`,
    );
  }
}

function capabilityOwnsLibraryFiles(
  installed: DadsCapabilityInstallation | undefined,
  expected: DadsCapabilityInstallation,
): boolean {
  return (
    installed !== undefined &&
    installed.recipeVersion === expected.recipeVersion &&
    installed.profile === expected.profile &&
    installed.client === expected.client &&
    expected.ownedFiles.every((path) => installed.ownedFiles.includes(path))
  );
}

function libraryVerificationIsRegistered(
  project: DadsProject,
  packageName: string,
  taskId: string,
): boolean {
  if (project.schemaVersion === 1) {
    return project.verificationPolicy.tasks.some(
      (task) => task.packageName === packageName,
    );
  }
  return (
    project.verificationPolicy.fullFallbackTaskIds.includes(taskId) &&
    project.verificationPolicy.tasks.some(
      (task) => task.id === taskId && task.packageName === packageName,
    )
  );
}

export function libraryProjectManifest(
  manifest: Record<string, unknown>,
  owner: DadsPackageDeclaration,
  capability: DadsCapabilityInstallation,
): Record<string, unknown> {
  const project = {
    ...manifest,
    packages: [...readArray(manifest, "packages"), owner],
    capabilities: [...readArray(manifest, "capabilities"), capability],
  };
  const verification = manifest["verification"];
  if (isRecord(verification) && manifest["schemaVersion"] !== 1) {
    const task = {
      id: libraryTaskId(owner.name),
      packageName: owner.name,
      command: owner.verification[0],
      dependsOn: [],
      sourceInputs: [owner.root],
      nonSourceInputs: ["package.json", "package-lock.json"],
      reusePolicy: "never",
      ...(manifest["schemaVersion"] === 3
        ? { execution: { kind: "shell" } }
        : {}),
    };
    Object.assign(project, {
      verification: {
        ...verification,
        tasks: [...readArray(verification, "tasks"), task],
        fullFallbackTaskIds: [
          ...readArray(verification, "fullFallbackTaskIds"),
          task.id,
        ],
      },
    });
  }
  parseDadsProject(project);
  return project;
}

export function libraryTaskId(packageName: string): string {
  return `${packageName}:library-test`;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!isUnknownArray(value)) throw new Error(`${key} must be an array.`);
  return value;
}
