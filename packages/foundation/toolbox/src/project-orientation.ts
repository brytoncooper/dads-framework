import type { VerificationPolicy, VerificationTaskDefinition } from "./verification/verification-contract.js";
import { isRecord } from "./parse-guards.js";
import {
  assertExecutionReferences,
  assertKnownTaskIds,
  normalizeProjectPath,
  parseVerificationExecution,
  readNonEmptyString,
  readReusePolicy,
  readStringArray,
} from "./verification-policy-parsing.js";

export type DadsPackageDeclaration = {
  readonly name: string;
  readonly root: string;
  readonly responsibility: string;
  readonly allowedDependencies: readonly string[];
  readonly verification: readonly string[];
  readonly skills: readonly string[];
};

export type DadsCapabilityInstallation = {
  readonly name: string;
  readonly recipeVersion: number;
  readonly profile: string;
  readonly client: string;
  readonly ownedFiles: readonly string[];
};

export type DadsProject = {
  readonly schemaVersion: 1 | 2 | 3;
  readonly capabilities: readonly DadsCapabilityInstallation[];
  readonly packages: readonly DadsPackageDeclaration[];
  readonly verificationPolicy: VerificationPolicy;
};

export type ProjectOrientation = {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly responsibility: string;
  readonly allowedDependencies: readonly string[];
  readonly verification: readonly string[];
  readonly skills: readonly string[];
};

export function parseDadsProject(input: unknown): DadsProject {
  if (
    !isRecord(input) ||
    (input["schemaVersion"] !== 1 && input["schemaVersion"] !== 2 && input["schemaVersion"] !== 3)
  ) {
    throw new Error("Dads project schemaVersion must be 1, 2, or 3.");
  }

  const packageInputs = input["packages"];
  if (!Array.isArray(packageInputs)) {
    throw new Error("Dads project packages must be an array.");
  }

  const packages = packageInputs.map(parsePackageDeclaration);
  const capabilities = parseCapabilities(input["capabilities"]);
  assertUniquePackageValues(packages, "name", "duplicate package name");
  assertUniquePackageValues(packages, "root", "duplicate package root");
  assertUniqueCapabilityNames(capabilities);
  const schemaVersion = input["schemaVersion"];
  const verificationPolicy =
    schemaVersion === 1
      ? createLegacyVerificationPolicy(packages)
      : parseVerificationPolicy(input["verification"], packages, schemaVersion);
  return { schemaVersion, capabilities, packages, verificationPolicy };
}

export function orientProjectPath(project: DadsProject, requestedPath: string): ProjectOrientation | undefined {
  const normalizedPath = normalizeProjectPath(requestedPath);
  const owningPackages = project.packages
    .filter((candidate) => normalizedPath === candidate.root || normalizedPath.startsWith(`${candidate.root}/`))
    .sort((firstPackage, secondPackage) => secondPackage.root.length - firstPackage.root.length);
  const owner = owningPackages[0];
  if (!owner) {
    return undefined;
  }

  return {
    packageName: owner.name,
    packageRoot: owner.root,
    responsibility: owner.responsibility,
    allowedDependencies: owner.allowedDependencies,
    verification: owner.verification,
    skills: owner.skills,
  };
}

function parsePackageDeclaration(input: unknown): DadsPackageDeclaration {
  if (!isRecord(input)) {
    throw new Error("Every Dads package declaration must be an object.");
  }

  return {
    name: readNonEmptyString(input, "name"),
    root: normalizeProjectPath(readNonEmptyString(input, "root")),
    responsibility: readNonEmptyString(input, "responsibility"),
    allowedDependencies: readStringArray(input, "allowedDependencies"),
    verification: readStringArray(input, "verification"),
    skills: readStringArray(input, "skills"),
  };
}

function createLegacyVerificationPolicy(packages: readonly DadsPackageDeclaration[]): VerificationPolicy {
  const tasks = packages.flatMap((packageDeclaration) =>
    packageDeclaration.verification.map((command, commandIndex) =>
      createLegacyVerificationTask(packageDeclaration, command, commandIndex),
    ),
  );
  return {
    kind: "legacy",
    projectId: "legacy-project",
    tasks,
    fullFallbackTaskIds: tasks.map((task) => task.id),
  };
}

function createLegacyVerificationTask(
  packageDeclaration: DadsPackageDeclaration,
  command: string,
  commandIndex: number,
): VerificationTaskDefinition {
  return {
    id: `${packageDeclaration.name}:verify:${String(commandIndex + 1)}`,
    packageName: packageDeclaration.name,
    command,
    dependsOn: [],
    sourceInputs: [packageDeclaration.root],
    nonSourceInputs: [],
    reusePolicy: "never",
    execution: { kind: "shell" },
  };
}

function parseVerificationPolicy(
  input: unknown,
  packages: readonly DadsPackageDeclaration[],
  schemaVersion: 2 | 3,
): VerificationPolicy {
  if (!isRecord(input)) {
    throw new Error("Dads project verification must be an object.");
  }
  const taskInputs = input["tasks"];
  if (!Array.isArray(taskInputs)) {
    throw new Error("Dads project verification tasks must be an array.");
  }
  const packageNames = new Set(packages.map((entry) => entry.name));
  const tasks = taskInputs.map((taskInput) => parseVerificationTask(taskInput, packageNames, schemaVersion));
  assertUniqueTaskIds(tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskIds = new Set(taskById.keys());
  for (const task of tasks) {
    assertKnownTaskIds(task.dependsOn, taskIds, `dependencies for ${task.id}`);
    assertExecutionReferences(task, taskById);
  }
  const fullFallbackTaskIds = readStringArray(input, "fullFallbackTaskIds");
  assertKnownTaskIds(fullFallbackTaskIds, taskIds, "full fallback tasks");
  return {
    kind: "task-graph",
    projectId: schemaVersion === 3 ? readNonEmptyString(input, "projectId") : "version-2-project",
    tasks,
    fullFallbackTaskIds,
  };
}

function parseVerificationTask(
  input: unknown,
  packageNames: ReadonlySet<string>,
  schemaVersion: 2 | 3,
): VerificationTaskDefinition {
  if (!isRecord(input)) {
    throw new Error("Every Dads verification task must be an object.");
  }
  const packageName = readNonEmptyString(input, "packageName");
  if (!packageNames.has(packageName)) {
    throw new Error(`Dads verification task references unknown package ${packageName}.`);
  }
  if (schemaVersion === 2 && input["execution"] !== undefined) {
    throw new Error("Verification execution semantics require Dads project schemaVersion 3.");
  }
  return {
    id: readNonEmptyString(input, "id"),
    packageName,
    command: readNonEmptyString(input, "command"),
    dependsOn: readStringArray(input, "dependsOn"),
    sourceInputs: readStringArray(input, "sourceInputs").map(normalizeProjectPath),
    nonSourceInputs: readStringArray(input, "nonSourceInputs").map(normalizeProjectPath),
    reusePolicy: readReusePolicy(input),
    execution: schemaVersion === 3 ? parseVerificationExecution(input["execution"]) : { kind: "shell" },
  };
}

function assertUniqueTaskIds(tasks: readonly VerificationTaskDefinition[]): void {
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new Error(`duplicate verification task id: ${task.id}`);
    }
    taskIds.add(task.id);
  }
}

function parseCapabilities(input: unknown): readonly DadsCapabilityInstallation[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error("Dads project capabilities must be an array.");
  }
  return input.map((capability) => {
    if (!isRecord(capability)) {
      throw new Error("Every Dads capability must be an object.");
    }
    const recipeVersion = capability["recipeVersion"];
    if (typeof recipeVersion !== "number" || !Number.isInteger(recipeVersion) || recipeVersion < 1) {
      throw new Error("Dads capability recipeVersion must be a positive integer.");
    }
    return {
      name: readNonEmptyString(capability, "name"),
      recipeVersion,
      profile: readNonEmptyString(capability, "profile"),
      client: readNonEmptyString(capability, "client"),
      ownedFiles: readStringArray(capability, "ownedFiles").map(normalizeProjectPath),
    };
  });
}

/** Refuses a repeated package field; `verification/verification-inputs.ts` has `assertUniqueValues` for plain strings. */
function assertUniquePackageValues(
  packages: readonly DadsPackageDeclaration[],
  field: "name" | "root",
  failure: string,
): void {
  const values = new Set<string>();
  for (const packageDeclaration of packages) {
    const declaredValue = packageDeclaration[field];
    if (values.has(declaredValue)) {
      throw new Error(`${failure}: ${declaredValue}`);
    }
    values.add(declaredValue);
  }
}

function assertUniqueCapabilityNames(capabilities: readonly DadsCapabilityInstallation[]): void {
  const names = new Set<string>();
  for (const capability of capabilities) {
    if (names.has(capability.name)) {
      throw new Error(`duplicate capability name: ${capability.name}`);
    }
    names.add(capability.name);
  }
}
